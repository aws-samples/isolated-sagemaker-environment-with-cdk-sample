# What's this

SageMaker Studio において、個々のユーザが独立した環境で学習ジョブを実行するための環境作成CDKのサンプルです。それぞれのユーザが使えるS3バケットや環境は分離され独立しているため、データの共有は行われません。

環境は下記のように作成されます
* SageMaker Studioおよび学習ジョブからのインターネットへの疎通禁止
* CodeArtifact による pypi へのpipによるアクセス
* 最小権限を与えられた、SageMaker Studioドメインの UserProfile

各Userは、SageMaker Studio で学習ジョブを実行する最低限の権限としています。許可されていることのサマリは下記です
* 各UserProfile(Role)ごとに用意されたS3バケットへの読み書き
* 学習ジョブの実行によるモデルの作成と、そのS3への保存。
* 自分が実行した学習ジョブの停止
* SageMakerStudio でのApp作成 (JupyterNotebookの実行のためのKernelGateway作成のため)
許可されていないことは例えば下記があります
* 推論エンドポイントの作成
* SageMakerのデフォルトバケットへの読み書き
* 他のユーザ用のS3バケットへの読み書き
* 他のユーザが実行した学習ジョブの停止
もし、作成したモデルを使ってデプロイする場合、モデルレジストリへの登録->承認->デプロイのワークフローを追加で作成することなどが考えられます


# how to deploy

cdk.jsonにて、`userNames`にユーザ名を指定
```
npm ci
```

```
npm run cdk bootstrap
```

```
npm run cdk -- deploy --all
```

# Operation

- SageMaker Studio を任意のUserProfileで起動
- `test/train.py`および`test/testbook.ipynb`を SageMaker StudioにDrag&Dropなどでアップロード
- `testbook.ipynb` に従って実行

※ どのIAM RoleやIAM User がどの UserProfile を起動できるかの設定はこのサンプルの対象外です