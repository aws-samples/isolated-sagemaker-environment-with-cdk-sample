import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codeartifact from 'aws-cdk-lib/aws-codeartifact';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';

export interface SagemakerGovernanceStackProps extends cdk.StackProps {
  userNames: string[];
}

export class SagemakerGovernanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SagemakerGovernanceStackProps) {
    super(scope, id, props);

    // Domain 用のVPCを作成します
    const vpc = this.makeVpc();

    // SageMaker Domain 用の default execution Role。defaultなので何もできないようにします
    const defaultRole = new iam.Role(this, 'DefaultRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com')
    });

    // Security Group
    const domainSecurityGroup = new ec2.SecurityGroup(this, 'DomainSecurityGroup', {
      vpc,
      allowAllOutbound: true
    });
    domainSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcpRange(8192, 65535));

    // Studio Domain
    const domainName = cdk.Stack.of(this).stackName.toLowerCase() + '-domain';
    const domain = new sagemaker.CfnDomain(this, 'Domain', {
      authMode: 'IAM',
      defaultUserSettings: {
        executionRole: defaultRole.roleArn,
        securityGroups: [domainSecurityGroup.securityGroupId],
        jupyterServerAppSettings: {}
      },
      domainName: domainName,
      vpcId: vpc.vpcId,
      subnetIds: vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
      appNetworkAccessType: 'VpcOnly'
    });
    domain.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // CodeArtifact (これにより、インターネットにSageMakerから接続しなくても pip installをできます)
    const codeartifactDomain = new codeartifact.CfnDomain(this, 'codeartifactDomain', {
      domainName: domainName
    });
    const codeartifactRepository = new codeartifact.CfnRepository(this, 'codeartifactRepository', {
      domainName: domainName,
      repositoryName: domainName,
      externalConnections: ['public:pypi']
    });
    codeartifactRepository.addDependency(codeartifactDomain);

    props.userNames.forEach((userName) => {
      const userRole = new iam.Role(this, `UserRole${userName}`, {
        assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal('sagemaker.amazonaws.com')),
        roleName: `UserRole${userName}`
      });

      this.makeUserEnvironment(
        domain.attrDomainId,
        userRole.roleArn,
        userName,
        codeartifactDomain,
        codeartifactRepository
      );
    });
  }

  // 共通のポリシの付与しています
  addCommonPolicy(
    role: iam.IRole,
    codeartifactDomain: codeartifact.CfnDomain,
    codeartifactRepository: codeartifact.CfnRepository
  ) {
    // 共用 CodeArtifact リポジトリへのアクセス許可
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'codeartifact:DescribeDomain',
          'codeartifact:DescribeRepository',
          'codeartifact:GetAuthorizationToken',
          'codeartifact:GetRepositoryEndpoint',
          'codeartifact:GetRepositoryPermissionsPolicy',
          'codeartifact:ListPackages',
          'codeartifact:ListRepositories',
          'codeartifact:ListTagsForResource',
          'codeartifact:ReadFromRepository'
        ],
        resources: [codeartifactDomain.attrArn, codeartifactRepository.attrArn]
      })
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:GetServiceBearerToken'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'sts:AWSServiceName': 'codeartifact.amazonaws.com'
          }
        }
      })
    );

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'sagemaker:CreateModel',
          'sagemaker:DescribeDomain',
          'sagemaker:ListModels',
          'sagemaker:ListDomains',
          'sagemaker:ListUserProfiles',
          'sagemaker:ListTags',
          'sagemaker:ListSharedModelEvents',
          'logs:DescribeLogStreams'
        ],
        resources: ['*']
      })
    );
    // CloudWatchLogsからログの取得は比較的ゆるめになっています(他ユーザのログも取得できます)
    // SageMaker Python SDK で学習する場合にTrainingJobのログの取得が必要であるためです
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['logs:GetLogEvents'],
        resources: [
          `arn:aws:logs:${cdk.Stack.of(this).region}:${
            cdk.Stack.of(this).account
          }:log-group:/aws/sagemaker/TrainingJobs:log-stream:*`
        ]
      })
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [role.roleArn],
        conditions: {
          StringEqualsIfExists: {
            'iam:PassedToService': 'sagemaker.amazonaws.com'
          }
        }
      })
    );
  }

  /**
   *
   * SageMakerのユーザを作成。ユーザごとにS3バケットを分けて、そのバケットにのみアクセス可能とします
   * また各Userは、SageMaker Studio で学習ジョブを実行する最低限の権限としています。許可されていることのサマリは下記です
   * - 各UserProfile(Role)ごとに用意されたS3バケットへの読み書き
   * - 学習ジョブの実行によるモデルの作成と、そのS3への保存
   * - SageMakerStudio でのApp作成 (JupyterNotebookの実行のためのKernelGateway作成のため)
   * 許可されていないことは例えば下記があります
   * - 推論エンドポイントの作成
   * - SageMakerのデフォルトバケットへの読み書き
   * - 他のUserProfile用のS3バケットへの読み書き
   * もし、作成したモデルを使ってデプロイする場合、モデルレジストリへの登録->承認->デプロイのワークフローを追加で作成することなどが考えられます
   */

  makeUserEnvironment(
    domainId: string,
    userRoleArn: string,
    userName: string,
    codeartifactDomain: codeartifact.CfnDomain,
    codeartifactRepository: codeartifact.CfnRepository
  ) {
    const userRole = iam.Role.fromRoleArn(this, userName + 'Role', userRoleArn);
    // 共通のSageMakerのPolicyを付与
    this.addCommonPolicy(userRole, codeartifactDomain, codeartifactRepository);

    // 専用バケット作成。他の SageMakerUser からはみれません
    const bucket = new s3.Bucket(this, userName + 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });
    userRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:Abort*',
          's3:DeleteObject*',
          's3:GetBucket*',
          's3:GetObject*',
          's3:List*',
          's3:PutObject',
          's3:PutObjectLegalHold',
          's3:PutObjectRetention',
          's3:PutObjectTagging',
          's3:PutObjectVersionTagging'
        ],
        resources: [bucket.bucketArn, bucket.arnForObjects('*')]
      })
    );

    // SageMaker Studio Domain の UserProfile を作成します
    const userProfile = new sagemaker.CfnUserProfile(this, userName + 'Profile', {
      domainId: domainId,
      userProfileName: userName,
      userSettings: {
        executionRole: userRoleArn
      }
    });
    userRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:ListApps',
          'sagemaker:DescribeApp',
          'sagemaker:CreateApp',
          'sagemaker:DeleteApp',
          'sagemaker:CreatePresignedDomainUrl',
          'sagemaker:DescribeUserProfile'
        ],
        resources: [
          userProfile.attrUserProfileArn,
          userProfile.attrUserProfileArn + '/*',
          `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${
            cdk.Stack.of(this).account
          }:app/${domainId}/${userName.toLowerCase()}/*`
        ]
      })
    );

    // トレーニングジョブの実行権限。jobnameの先頭に"<自分のユーザ名>-"を入れると学習ジョブを起動できます
    userRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:CreateTrainingJob'],
        resources: [
          `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:training-job/${userName}-*`
        ],
        conditions: {
          Bool: {
            'sagemaker:NetworkIsolation': 'true'
          }
        }
      })
    );

    // トレーニングジョブのStop/Describe権限。jobnameの先頭が"<自分のユーザ名>-"の場合のみDescribeやStopが実行可能とします
    userRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:StopTrainingJob', 'sagemaker:DescribeTrainingJob'],
        resources: [
          `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:training-job/${userName}-*`
        ]
      })
    );
  }

  makeVpc() {
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24
        }
      ]
    });

    // インターネットに出ないでAWSの各サービスを利用するためにVPCエンドポイントを設定します
    new ec2.InterfaceVpcEndpoint(this, `STSVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `LogsVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `LakeFormationVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.LAKE_FORMATION,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `AthenaVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.ATHENA,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `EcrVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `EcrDockerVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `KmsVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `CodeArtifactApiVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.CODEARTIFACT_API,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `CodeArtifactRepositoriesVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.CODEARTIFACT_REPOSITORIES,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `CodeCommitVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.CODECOMMIT,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `SmApiVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_API,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `SmStudioApiVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_STUDIO,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `SmNotebookRuntimeApiVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_NOTEBOOK,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, `SmRuntimeApiVpcEndpoint`, {
      service: ec2.InterfaceVpcEndpointAwsService.SAGEMAKER_RUNTIME,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerApiVpcEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      vpc: vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }
    });

    vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }]
    });
    return vpc;
  }
}
