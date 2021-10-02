import { CfnOutput, CfnParameter, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_certificatemanager as acm,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_route53 as route53,
} from 'aws-cdk-lib';

export interface ScimBridgeStackProps extends StackProps {
  domainName: string;
};

export class ScimBridgeStack extends Stack {
  constructor(scope: Construct, id: string, props: ScimBridgeStackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // const domainName = new CfnParameter(this, 'DomainName', {
    //   type: 'String',
    //   description: 'Domain name',
    //   default: 'scim-bridge.example.com',
    //   minLength: 1,
    //   maxLength: 253,
    // });

    const hostedZone = new CfnParameter(this, 'HostedZone', {
      type: 'AWS::Route53::HostedZone::Id',
      description: 'Hosted zone',
    });

    // const vpc = new ec2.Vpc(this, 'VPC', {
    //   maxAzs: 3,
    // });

    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      isDefault: true,
    });

    const scimSessionSecret = new secretsmanager.Secret(this, 'ScimSessionSecret', {
      secretName: 'scim-bridge-scimsession',
    });

    // TODO: Secret value

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: 'scim-bridge-logs',
    });

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: vpc,
      description: 'Security group for SCIM bridge load balancer',
    });

    new ec2.CfnSecurityGroupIngress(this, 'LoadBalancerHttpIngress', {
      ipProtocol: 'tcp',
      fromPort: 80,
      toPort: 80,
      cidrIp: '0.0.0.0/0',
    });

    new ec2.CfnSecurityGroupIngress(this, 'LoadBalancerHttpsIngress', {
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      cidrIp: '0.0.0.0/0',
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: vpc,
      description: 'Security group for SCIM bridge service',
    });

    new ec2.CfnSecurityGroupIngress(this, 'ServiceSecurityGroupIngress', {
      ipProtocol: 'tcp',
      fromPort: 3002,
      toPort: 3002,
      groupId: loadBalancerSecurityGroup.securityGroupId,
    });

    const httpTargetGroup = new elbv2.ApplicationTargetGroup(this, 'HttpTargetGroup', {
      targetGroupName: 'target-group-http',
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 3002,
      vpc: vpc,
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200,301,302',
      },
      targetType: elbv2.TargetType.IP,
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc,
      clusterName: 'scim-bridge',
    });

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'scim-bridge-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    scimSessionSecret.grantRead(executionRole);

    const taskDefinition = new ecs.CfnTaskDefinition(this, 'TaskDefinition', {
      family: 'scim-bridge',
      executionRoleArn: executionRole.roleArn,
      networkMode: 'awsvpc',
      containerDefinitions: [
        {
          image: '1password/scim:v2.1.2',
          cpu: 128,
          memory: 512,
          essential: true,
          portMappings: [
            {
              containerPort: 3002,
              hostPort: 3002,
            },
          ],
          dependsOn: [
            {
              containerName: 'redis',
              condition: 'START',
            },
          ],
          environment: [
            {
              name: 'OP_REDIS_URL',
              value: 'redis://localhost:6379',
            },
            {
              name: 'OP_LETSENCRYPT_DOMAIN',
              value: '',
            },
          ],
          secrets: [
            {
              name: 'OP_SESSION',
              valueFrom: scimSessionSecret.secretArn,
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logGroup.logGroupName,
              'awslogs-region': this.region,
              'awslogs-stream-prefix': 'ecs-scim',
            },
          },
        },
        {
          image: 'redis:latest',
          cpu: 128,
          memory: 256,
          essential: true,
          portMappings: [
            {
              containerPort: 6379,
              hostPort: 6379,
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logGroup.logGroupName,
              'awslogs-region': this.region,
              'awslogs-stream-prefix': 'ecs-redis',
            },
          },
        },
      ],
      cpu: '256',
      memory: '512',
    });

    const service = new ecs.CfnService(this, 'Service', {
      cluster: cluster.clusterArn,
      serviceName: 'scim-bridge-service',
      taskDefinition: taskDefinition.attrTaskDefinitionArn,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      loadBalancers: [
        {
          targetGroupArn: httpTargetGroup.targetGroupArn,
          containerName: 'scim-bridge',
          containerPort: 3002,
        },
      ],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: vpc.publicSubnets.map((s) => s.subnetId),
          assignPublicIp: 'ENABLED',
          securityGroups: [serviceSecurityGroup.securityGroupId],
        },
      },
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      // domainName: domainName.valueAsString,
      domainName: props.domainName,
      // TODO
      // validation: acm.CertificateValidation.fromDns(Fn.ref(hostedZone.logicalId)),
      validation: acm.CertificateValidation.fromDns(),
    });

    // const certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
    //   domainName: domainName.valueAsString,
    //   hostedZone: 'EXAMPLE123',
    //   validation: acm.ValidationMethod.DNS,
    // });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: vpc,
      loadBalancerName: 'scim-bridge-alb',
      securityGroup: loadBalancerSecurityGroup,
      vpcSubnets: { subnets: vpc.publicSubnets },
    });

    const httpsListener = new elbv2.ApplicationListener(this, 'HttpsListener', {
      loadBalancer: loadBalancer,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      port: 443,
      sslPolicy: elbv2.SslPolicy.TLS12,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.forward([httpTargetGroup]),
    });

    service.node.addDependency(httpsListener);

    // TODO: Route 53 record for load balancer
    // const record = new route53.ARecord(this, 'ScimBridgeARecord', {
    //   recordName: domainName.valueAsString,
    //   target: new route53.RecordTarget.fromAlias(),
    //   // target: loadBalancer.loadBalancerDnsName,
    //   zone: hostedZone,
    // });

    // Outputs

    new CfnOutput(this, 'CloudWatchLogGroup', {
      description: 'Where you can find your scim-bridge logs',
      value: logGroup.logGroupName,
    });

    new CfnOutput(this, 'LoadBalancerDnsName', {
      description: 'The Load balancer address to set in your DNS',
      value: loadBalancer.loadBalancerDnsName,
    });
  }
}
