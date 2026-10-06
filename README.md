# SmartQueue

SmartQueue is a responsive service appointment and queue management application for colleges, salons, banks, government service centers, clinics, and other appointment-based organizations. The React frontend calls an AWS serverless API; it does not use a mock backend or treat browser storage as application data.

## Problem and objectives

Long, unpredictable queues waste customers' time and make service operations difficult to coordinate. SmartQueue lets customers find an organization and service, book a real available time, join a walk-in queue, track their queue, receive updates, and securely attach documents. Staff can operate an assigned service queue and administrators can add organizations, departments, and services.

## Features

- Amazon Cognito sign-up, email verification, login, logout, and password recovery
- Role-aware user, staff, and administrator screens
- Organization, department, and service selection backed by DynamoDB
- Appointment booking with server-generated IDs and queue tokens
- Unique, transactional time-slot reservations and rescheduling/cancellation
- FIFO queue ordering with optional staff-managed priority and configurable average service duration
- Queue position and wait estimates calculated from current active entries
- Walk-in queue tokens, check-in, call next, service start/completion, skip, no-show, and pause/resume
- REST queue polling every 10 seconds for live status updates
- Private S3 document storage through short-lived presigned POST forms; PDF, JPEG, and PNG files up to 10 MB
- User-filtered SNS email topics and in-app notifications; EventBridge appointment reminders
- SQS event processing, Lambda/API Gateway CloudWatch logs, and AWS SAM infrastructure
- Public-read S3 static website bucket limited to compiled frontend files; documents remain in a separate private S3 bucket

## Architecture

```text
Browser -> S3 static website (compiled React files; public read only)
   | HTTPS API calls with Cognito JWT; S3 website itself is HTTP-only
   v
API Gateway HTTP API -> API Lambda -> DynamoDB (3 GSIs)
                              |     -> private S3 documents (presigned POST)
                              |     -> SQS -> notification worker -> per-user SNS email
EventBridge daily schedule -> reminder Lambda -> DynamoDB + opted-in SNS topics
Cognito User Pool -> JWT authorizer and USER / STAFF / ADMIN groups
CloudWatch -> 14-day Lambda/API logs + error/DLQ alarms -> operations SNS topic
```

The React build is hosted directly by the S3 static website endpoint; only `index.html` and `/assets/*` in the dedicated frontend bucket allow public `GetObject` access. The deployment syncs only `frontend/dist` into that bucket, which is not used for user uploads. The documents bucket blocks all public access and is used only through authenticated Lambda operations and short-lived presigned URLs. API Gateway and Lambda handle application API requests only. The S3 website endpoint is HTTP-only without CloudFront or a custom TLS endpoint. Queue views poll the authenticated REST endpoint every 10 seconds.

## AWS resources

`infrastructure/template.yaml` deploys:

- Amazon Cognito User Pool, public web client, and USER/STAFF/ADMIN groups
- Amazon API Gateway HTTP API with Cognito JWT authorization
- AWS Lambda API, SQS notification worker, and reminder handler
- Amazon DynamoDB on-demand single table with three GSIs for user/catalog/document lookups, service/date appointments, and staff/date appointments
- Private encrypted S3 document bucket; a separate S3 static website bucket with public read limited to frontend objects
- Amazon SQS queue and dead-letter queue
- Amazon SNS operational alert topic for CloudWatch alarms; per-user email topics are created for verified users who opt in
- Amazon EventBridge daily reminder schedule
- API Gateway access logs and Lambda log groups are retained in CloudWatch for 14 days, with alarms for API Lambda errors and dead-letter queue messages
- SAM-generated least-privilege execution roles for each Lambda function

The frontend only speaks to the API service layer at `frontend/src/services/api.js`. It never connects directly to DynamoDB.

## DynamoDB design and access patterns

The `smartqueue-application` table uses `PK` and `SK` as its primary key and on-demand billing. Entities use namespaced keys:

| Entity | Partition/sort key | Indexes and access pattern |
|---|---|---|
| User profile | `USER#userId / PROFILE` | Owned by the Cognito subject |
| Organization | `ORGANIZATION#id / DETAIL` | GSI1 `ORGANIZATIONS / ORGANIZATION#id` |
| Department | `DEPARTMENT#id / DETAIL` | GSI1 `ORG#organizationId / DEPARTMENT#id` |
| Service | `SERVICE#id / DETAIL` | GSI1 `ORG#organizationId / SERVICE#id` |
| Appointment | `APPOINTMENT#id / DETAIL` | GSI1 user appointments; GSI2 service/date; GSI3 staff/date |
| Queue counter and entries | `QUEUE#serviceId#date / COUNTER or ENTRY#sequence` | Base-table partition query; GSI1 appointment-to-queue |
| Slot reservation | `SLOT#serviceId#date / TIME#time` | Point read and conditional transactional put prevent double booking |
| Document metadata | `DOCUMENT#id / DETAIL` | GSI1 appointment documents |
| Notification | `USER#userId / NOTIFICATION#timestamp#id` | Query only that authenticated user's notifications |

Only three GSIs are provisioned. GSI1 is shared by namespaced user, organization, appointment, and document partitions. GSI2 retrieves appointments by service and date for reminders. GSI3 retrieves assigned staff appointments by staff and date. Queue entries are queried directly from their service/date base-table partition; staff queue actions provide that service/date and find the entry in the partition. Normal request paths use `GetItem`/`Query`, not table scans.

## S3 document architecture

The application creates metadata in DynamoDB and returns a five-minute S3 presigned POST. The POST policy constrains MIME type and file length. After the browser uploads the file, the API confirms the stored object's size and content type before marking it uploaded. The document bucket is private, encrypted, unversioned, blocks public access, and denies non-TLS requests. Downloads use an ownership-checked five-minute presigned GET; deletion removes the S3 object and marks the metadata deleted. The separate frontend bucket has S3 static website hosting enabled and allows anonymous `GetObject` only for compiled site files. Never store documents or secrets in that bucket.

## API

The S3 website hosts the frontend independently. Every application route below is an API Gateway route and requires a Cognito JWT.

| Method | Path | Purpose |
|---|---|---|
| GET | `/organizations` | List organizations |
| GET | `/organizations/{id}/departments` | List organization departments |
| GET | `/services?organizationId=...` | List organization services |
| GET | `/services/{id}` | Get service details |
| GET | `/services/{id}/availability?date=YYYY-MM-DD` | Return unreserved times |
| POST | `/appointments` | Atomically reserve a time and create an appointment and queue entry |
| GET | `/appointments/my` | List the caller's appointments |
| GET/PUT/DELETE | `/appointments/{id}` | Get, reschedule, or cancel an owned appointment |
| POST | `/appointments/{id}/check-in` | Check in an appointment |
| POST | `/queue/join` | Join today's walk-in queue |
| GET | `/queue/{serviceId}?date=YYYY-MM-DD` | Read queue and caller's position |
| POST | `/queue/next` | Staff call the next FIFO/priority entry |
| POST | `/queue/{queueId}/{start\|complete\|skip\|no-show}` | Change a queue entry's status; body includes `serviceId` and `date` |
| POST | `/queue/{serviceId}/{pause\|resume}` | Pause or resume an assigned service queue |
| POST | `/documents/upload` | Create a private upload form and metadata |
| POST | `/documents/{id}/complete` | Verify uploaded object and finalize metadata |
| GET | `/appointments/{id}/documents` | List appointment documents |
| GET/DELETE | `/documents/{id}` | Secure download URL / delete |
| GET | `/notifications` | List caller's in-app notifications |
| POST | `/notifications/subscribe` | Opt in to email alerts through a personal SNS topic |
| GET | `/users/me` | Get or create caller profile |
| GET | `/staff/appointments?date=...` | List appointments assigned to the staff member |
| POST | `/admin/organizations`, `/admin/departments`, `/admin/services` | Manage service catalog |

`POST /appointments` expects `organizationId`, `serviceId`, `appointmentDate` (`YYYY-MM-DD`), and `appointmentTime` (a service-configured slot). `POST /queue/join` expects `organizationId` and `serviceId`. Error responses are JSON with a stable `code` and user-safe `message`.

## Authentication and roles

The public Cognito app client has no client secret. Registration sends passwords only to Cognito; passwords are never stored in DynamoDB. Email verification, password reset, and login use the Cognito Identity Provider API. The Cognito `USER`, `STAFF`, and `ADMIN` groups drive the role-specific UI and server-side authorization. New accounts are ordinary users; an administrator assigns staff/admin group membership using the AWS console or CLI.

## Queue and notification processing

Queue entries are ordered by descending staff-managed priority and then `joinTime` (FIFO for equal priority). DynamoDB atomic counters allocate unique tokens. Slot reservations use a conditional transactional put, preventing two users booking the same service/date/time. Queue status and appointment status are updated together in a transaction. Stale concurrent staff actions return a conflict instead of silently overwriting another action.

The API records in-app notifications and enqueues email notification events in SQS. A Lambda worker publishes these events to the opted-in user's own SNS topic. Queue status is read through the authenticated REST API and refreshed every 10 seconds in the browser. EventBridge runs the reminder Lambda daily at 00:05 UTC; it finds next-day appointments by querying the services/date GSI and sends in-app reminders plus optional email. Email delivery requires each user to confirm the SNS subscription sent to their verified address.

## Local development

Requirements: Node.js 20+ and npm. AWS credentials are not needed for frontend build or backend tests.

```powershell
npm ci
npm ci --prefix backend
Copy-Item .env.example .env
# Set the real deployed Cognito/API values in .env
npm run dev
```

The UI reports configuration/API errors when AWS settings or resources are missing and never fabricates bookings. Sign-in, booking, and dashboards require a deployed stack and environment configuration.

## AWS architecture

The SAM template creates Cognito, API Gateway HTTP API, three Lambda functions (API, SQS notification worker, daily reminder), one on-demand DynamoDB table with three GSIs, a private documents bucket, a static website bucket, SQS and DLQ, SNS topics, an EventBridge schedule, CloudWatch logs/alarms, and IAM roles. Queue updates use REST polling every 10 seconds. There is no WebSocket, CloudFront, EC2, or relational database.

The compiled React app is hosted by the S3 website endpoint. Public `GetObject` is limited to `index.html` and `assets/*`; deployment syncs `frontend/dist` only. Never upload secrets or user documents there. The documents bucket blocks all public access and is used through authorized Lambda calls and short-lived presigned URLs. The S3 website endpoint is HTTP-only. API Gateway and Lambda only handle application APIs.

## GitHub repository setup

Push the project to a GitHub repository and use `main` as the deployment branch. Commit both `package-lock.json` and `backend/package-lock.json`. Do not commit `.env`, `.env.production`, AWS credentials, or `.aws-sam` build output; these are ignored. In **Settings → Actions → General**, allow repository workflows to run.

## GitHub Actions setup

- `.github/workflows/ci.yml` runs on pull requests and pushes. It installs dependencies, validates repository/SAM configuration, builds the frontend, runs frontend tests if a `test` script exists (there currently is no frontend test suite), checks backend syntax, and runs backend tests. CI never deploys.
- `.github/workflows/deploy.yml` runs on pushes to `main` and `workflow_dispatch`. Manual dispatch must select `main`. It assumes an AWS role with GitHub OIDC, validates/builds/deploys the existing SAM template, reads CloudFormation outputs, builds with deployed Cognito/API values, uploads the compiled frontend to S3, and reports the outcome in the Actions run summary.

### Required GitHub repository variables

In **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Example/value |
|---|---|
| `AWS_REGION` | `us-east-1` |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::123456789012:role/smartqueue-github-deploy` |
| `AWS_STACK_NAME` | `smartqueue` |
| `AWS_APPLICATION_NAME` | `smartqueue` |
| `ALERTS_EMAIL` | Optional operations email; leave unset to disable alarm email subscription |

**GitHub secrets:** none are required for AWS. The workflow uses a short-lived OIDC token; never store AWS access keys in GitHub.

## AWS OIDC and deployment role

In IAM, create or reuse the GitHub OIDC provider with URL `https://token.actions.githubusercontent.com` and audience `sts.amazonaws.com`. Create the deploy role with this trust policy; replace `<AWS_ACCOUNT_ID>`, `<OWNER>`, and `<REPOSITORY>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPOSITORY>:ref:refs/heads/main"
      }
    }
  }]
}
```

This trust permits only the repository's `main` branch. For manual workflow dispatch select `main`. If the repository uses GitHub immutable OIDC subject claims, match the trust `sub` to the exact subject format GitHub issues for that repository; do not broaden trust to all branches.

Attach a deployment permissions policy to the role and set its ARN in `AWS_DEPLOY_ROLE_ARN`. It must allow CloudFormation stack/change-set operations; SAM artifact-bucket and object operations; frontend bucket list/upload/delete/location operations; lifecycle operations for resources in this template (Cognito, API Gateway v2 HTTP API, Lambda, DynamoDB, S3 website and bucket configuration, SQS, SNS, EventBridge, CloudWatch Logs and alarms); and IAM role/policy management for SAM-generated Lambda roles plus `iam:PassRole` restricted to those roles. Scope resources to this stack, app, account, and region wherever supported. Some create/list APIs require `"Resource": "*"`, which should be constrained with conditions/tags where supported. Do not grant IAM user/access-key creation or unrelated service permissions. CloudFormation deployment with `CAPABILITY_IAM` requires role-management permissions.

AWS Academy may prohibit OIDC provider creation, IAM role changes, or template resources. Confirm the lab permits these actions before attempting deploy. The deployment workflow does not need AWS credentials configured in this local environment.

## Trigger and verify deployment

- **Automatic:** push or merge to `main`; CI and deployment run.
- **Manual:** **Actions → Deploy SmartQueue → Run workflow**, selecting `main`.
- A green run summary reports the site URL, API URL, stack, and region. Open the website URL and verify the sign-in page loads.
- In CloudFormation, verify `CREATE_COMPLETE` or `UPDATE_COMPLETE` and outputs `FrontendUrl`, `ApiUrl`, `UserPoolId`, and `UserPoolClientId`. Then test sign-up/sign-in and booking after creating an ADMIN test account and configuring an organization, department, and service.
- A successful workflow confirms deployment and frontend upload, but does not replace browser/API acceptance testing.

The optional `AlertsEmail` parameter subscribes the email to the operations SNS topic for CloudWatch alarms; the recipient must confirm. User notification topics are created separately when verified users opt in. For initial catalog setup, add an account to Cognito's ADMIN group:

```powershell
aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username <verified-email> --group-name ADMIN --region <region>
```

Then sign in, open **Admin**, and create an organization, department, and service. Add a verified staff account to `STAFF` and assign its Cognito subject to the service as `staffId` to enable staff operations.

## Local tests and monitoring

```powershell
npm run build
npm run test:backend
node --check backend\src\index.mjs
node --check backend\src\worker.mjs
node --check backend\src\reminders.mjs
sam validate --lint --template-file infrastructure\template.yaml
```

Lambda errors are emitted as structured CloudWatch log entries without passwords, JWTs, or document contents. API responses avoid returning internal AWS exception details.

## Cost and cleanup

This DynamoDB table uses on-demand billing. Free usage and credits depend on the AWS account and Academy lab; do not assume charges will be covered. Potential charges include API Gateway requests, Lambda runtime, DynamoDB reads/writes/storage and all three GSIs, S3 storage/requests/website data transfer, SNS email, SQS messages, EventBridge schedules, CloudWatch ingestion/storage and alarms, Cognito activity/verification, and SAM deployment artifacts. Queue polling every 10 seconds generates API/Lambda traffic. The EventBridge reminder runs daily; log retention is 14 days. The static website is HTTP-only. Only compiled frontend files are public; documents remain private.

Before deleting the stack, back up needed data, empty both S3 buckets (CloudFormation cannot delete non-empty buckets), remove runtime-created per-user SNS topics/subscriptions, then delete the stack:

```powershell
aws s3 rm s3://<FrontendBucketName> --recursive --region <region>
aws s3 rm s3://<DocumentsBucketName> --recursive --region <region>
aws cloudformation delete-stack --stack-name <stack-name> --region <region>
```

The Academy template uses `Delete` policies for DynamoDB and both S3 buckets, so deleting the stack also deletes table data. Remove the SAM artifact bucket created by `--resolve-s3` if no longer needed, and verify the account billing dashboard.

## Future enhancements

- Schedule/holiday management and organization-configured business hours
- Automated queue service-time statistics and historical wait prediction
- Staff assignment management and administrator audit log
- Optional document malware scanning and retention policies
- End-to-end AWS integration tests in a disposable test account
