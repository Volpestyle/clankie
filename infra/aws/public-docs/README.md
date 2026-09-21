# AWS public docs deployment

The public docs build in `apps/docs` and deploy to an existing private S3 bucket
behind CloudFront. This repo owns the site and reusable deployment tooling;
production resource identifiers and operator records live in private operations
storage. See the [infrastructure boundary](../README.md).

## Configure deployment identity

An AWS administrator supplies the target account, bucket, distribution, and
GitHub repository, then runs the role setup from this checkout:

```bash
export AWS_ACCOUNT_ID=123456789012
export DOCS_BUCKET=example-docs
export DOCS_DISTRIBUTION_ID=EXAMPLEDISTRIBUTION
export DOCS_DEPLOY_REPOSITORY=OWNER/REPO
export DOCS_DEPLOY_ROLE_NAME=clankie-docs-deploy
infra/aws/public-docs/setup-deploy-role.sh provision
```

The account must match the current AWS credentials. The existing GitHub OIDC
provider must be present in that account. The role trusts only
`repo:OWNER/REPO:ref:refs/heads/main`; its policy permits synchronization of the
one bucket and invalidation of the one distribution. The script prints the
role ARN. It does not change DNS, certificates, or CloudFront configuration.

Configure these GitHub **repository variables** from the private deployment
configuration before enabling the Docs workflow:

| Variable               | Value                               |
| ---------------------- | ----------------------------------- |
| `AWS_REGION`           | Bucket region                       |
| `DOCS_BUCKET`          | Existing bucket name                |
| `DOCS_DISTRIBUTION_ID` | Existing CloudFront distribution ID |
| `DEPLOY_ROLE_ARN`      | ARN printed by the setup script     |

These identifiers grant no access by themselves. AWS access comes from the
restricted OIDC trust; GitHub stores no reusable AWS access key. Workflow logs
and AWS API output can still disclose identifiers, so variables are configuration
separation, not a secrecy boundary.

## Build and deploy

```bash
pnpm docs:public:check
```

Pull requests build and validate the site without deployment credentials.
A docs-affecting push to `main`, or a manual run on `main`, deploys the built
artifact and invalidates CloudFront. The deploy job rejects missing variables
before requesting an AWS identity. Source path filters live in the Docs workflow.
CloudFront must already own the certificate, domain alias, and directory-index
rewrite.
