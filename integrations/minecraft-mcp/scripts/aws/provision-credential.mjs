#!/usr/bin/env node
/** Admin-only scoped IAM setup. Secret flows memory -> canonical broker only. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createDefaultCredentialStore } from "../../../../packages/credential-broker/src/credential-store.ts";
const [account, region, instance] = process.argv.slice(2);
if (!/^\d{12}$/.test(account ?? "") || !/^i-[a-f0-9]+$/.test(instance ?? "") || !region)
  throw new Error("Usage: provision-credential.mjs ACCOUNT REGION INSTANCE");
function aws(service, operation, input) {
  const output = execFileSync(
    "aws",
    ["--region", region, service, operation, "--cli-input-json", JSON.stringify(input), "--output", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output.trim() ? JSON.parse(output) : {};
}
if (aws("sts", "get-caller-identity", {}).Account !== account) throw new Error("Wrong account");
const store = createDefaultCredentialStore();
const provider = "clankie_minecraft_aws";
if (await store.get(provider)) throw new Error("Broker credential already exists; refusing replacement");
const name = "clankie-minecraft-host",
  tags = [{ Key: "clankie:purpose", Value: "minecraft" }];
const users = aws("iam", "list-users", {}).Users;
if (users.some((u) => u.UserName === name))
  throw new Error("IAM user already exists; refusing to add credentials to an unverified principal");
// CreateUser also fails closed if another operator creates this name after the read.
aws("iam", "create-user", { UserName: name, Tags: tags });
if (aws("iam", "list-access-keys", { UserName: name }).AccessKeyMetadata.length)
  throw new Error("IAM keys already exist; refusing duplicate");
for (const [doc, type, file] of [
  ["ClankieMinecraftHost", "Command", "host-document.json"],
  ["ClankieMinecraftForward", "Session", "forward-document.json"],
]) {
  const content = readFileSync(new URL(file, import.meta.url), "utf8");
  const docs = aws("ssm", "list-documents", {
    Filters: [{ Key: "Name", Values: [doc] }],
  }).DocumentIdentifiers;
  if (docs.some((d) => d.Name === doc)) {
    const existing = aws("ssm", "get-document", { Name: doc, DocumentFormat: "JSON" });
    if (JSON.stringify(JSON.parse(existing.Content)) !== JSON.stringify(JSON.parse(content)))
      throw new Error("Existing SSM document differs; review before updating");
  } else
    aws("ssm", "create-document", {
      Name: doc,
      DocumentType: type,
      DocumentFormat: "JSON",
      Content: content,
      Tags: tags,
    });
}
const instanceArn = `arn:aws:ec2:${region}:${account}:instance/${instance}`;
const documentArn = (n) => `arn:aws:ssm:${region}:${account}:document/${n}`;
const policy = {
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["ec2:StartInstances", "ec2:StopInstances"], Resource: instanceArn },
    { Effect: "Allow", Action: ["ec2:DescribeInstances"], Resource: "*" },
    {
      Effect: "Allow",
      Action: ["ssm:SendCommand"],
      Resource: [instanceArn, documentArn("ClankieMinecraftHost")],
    },
    { Effect: "Allow", Action: ["ssm:GetCommandInvocation"], Resource: "*" },
    {
      Effect: "Allow",
      Action: ["ssm:StartSession"],
      Resource: instanceArn,
      // Explicit custom-document requests can omit this IAM context key.
      // The separate deny below also blocks the default shell when DocumentName is omitted.
      Condition: { BoolIfExists: { "ssm:SessionDocumentAccessCheck": "true" } },
    },
    { Effect: "Allow", Action: ["ssm:StartSession"], Resource: documentArn("ClankieMinecraftForward") },
    {
      Effect: "Deny",
      Action: ["ssm:StartSession"],
      NotResource: [instanceArn, documentArn("ClankieMinecraftForward")],
    },
    {
      Effect: "Allow",
      Action: ["ssm:TerminateSession", "ssm:ResumeSession", "ssmmessages:OpenDataChannel"],
      Resource: `arn:aws:ssm:${region}:${account}:session/${name}-*`,
    },
  ],
};
aws("iam", "put-user-policy", {
  UserName: name,
  PolicyName: "OneMinecraftInstance",
  PolicyDocument: JSON.stringify(policy),
});
const simulation = aws("iam", "simulate-custom-policy", {
  PolicyInputList: [JSON.stringify(policy)],
  ActionNames: ["ec2:StartInstances", "ec2:TerminateInstances", "ssm:SendCommand"],
  ResourceArns: [
    instanceArn,
    `arn:aws:ec2:${region}:${account}:instance/i-00000000000000000`,
    `arn:aws:ssm:${region}::document/AWS-RunShellScript`,
  ],
});
console.log(
  JSON.stringify({
    scopeSimulation: simulation.EvaluationResults.map((r) => ({
      action: r.EvalActionName,
      resource: r.EvalResourceName,
      decision: r.EvalDecision,
      resources: r.ResourceSpecificResults?.map((v) => ({
        resource: v.EvalResourceName,
        decision: v.EvalResourceDecision,
      })),
    })),
  }),
);
const key = aws("iam", "create-access-key", { UserName: name }).AccessKey;
try {
  await store.set(provider, {
    type: "api",
    key: JSON.stringify({ accessKeyId: key.AccessKeyId, secretAccessKey: key.SecretAccessKey }),
  });
  if (!(await store.get(provider))) throw new Error("Broker readback missing");
  console.log(JSON.stringify({ user: name, provider, stored: true }));
} catch (error) {
  aws("iam", "delete-access-key", { UserName: name, AccessKeyId: key.AccessKeyId });
  throw error;
}
