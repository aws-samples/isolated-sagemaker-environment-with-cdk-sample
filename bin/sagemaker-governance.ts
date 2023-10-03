#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { SagemakerGovernanceStack } from '../lib/sagemaker-governance-stack'

const app = new cdk.App()

const userNames = app.node.tryGetContext('userNames')
new SagemakerGovernanceStack(app, 'SagemakerGovernanceStack', {
  userNames: userNames,
})
