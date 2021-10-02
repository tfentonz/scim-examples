import * as cdk from 'aws-cdk-lib';
import * as ScimBridge from '../lib/scim-bridge-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new ScimBridge.ScimBridgeStack(app, 'MyTestStack');
    // THEN
    const actual = app.synth().getStackArtifact(stack.artifactId).template;
    expect(actual.Resources ?? {}).toEqual({});
});
