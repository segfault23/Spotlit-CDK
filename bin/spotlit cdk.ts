#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SpotlitCdkStack } from '../lib/stack';

const app = new cdk.App();
new SpotlitCdkStack(app, 'SpotlitCdkStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
