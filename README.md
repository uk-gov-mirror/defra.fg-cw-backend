# fg-cw-backend

## Running with other services

If you want to run this service with other farming grants applications see [fg-grants-core](https://github.com/DEFRA/fg-grants-core)

## Documentation

- [External Services Configuration](./docs/EXTERNAL_SERVICES.md) - How to configure and call external APIs
- [Workflow Components](./docs/WORKFLOW_COMPONENTS.md) - Workflow component reference

## Coding standards

### System architecture

The code is well organised in to layers of:

Input adaptors (can reference use-cases)

- Subscribers
- Router

Domain classes

- Domain models (retrieved/persisted by repositories)
- Use cases (Can reference repositories and manipulate domain models)

Output adaptors (referenced by use cases)

- Repositories (retrieve/persist domain models)

Shared modules, referenced by any layer

- `src/common/` - infrastructure with no opinion about the business: the
  logger, the Mongo client, the messaging clients, the paginator
- `src/events/` - the shared event domain: what an inbox/outbox event IS and
  means. Which rows are audit records (`event-audit.js`), how a list of them is
  selected (`event-list-filter.js`), the statuses they move through and how
  they are counted and grouped (`status-counts.js`, `event-facets.js`,
  `event-breakdown.js`), what a detail view of one contains
  (`event-detail.js`), what redriving one means (`event-redrive.js`), what
  purging one means (`event-purge.js`), how long a terminal one is kept
  (`event-retention.js`), and how a failure is recorded (`last-error.js`)

`src/events/` lived in `src/common/` and did not belong there: `common` is
infrastructure, and these files are nothing but opinion about one part of the
business. Both the case pollers and the actuator surface depend on them, which
is what makes them shared rather than either module's own.

The rule that keeps it honest: **`src/events/` may import `src/common/` and
nothing else.** A domain module that reached into a context would tie every
other context to that one, which is the coupling moving it out of `common` was
meant to end. Every module may enter it; it enters no module.

`src/cases/events/` - the per-context folder holding published event shapes -
is a different thing that shares a word: one context's outbound vocabulary,
rather than the shared meaning of the stores themselves.

All code should honour these rules and they are enforced by ESLint (see eslint.config.js zones section)

### Code structure

We cannot use TypeScript due to RPA coding standards, but we can (and should) type our code when it makes sense for
robustness via Node JS type stripping. See /docs/ADR/0002_use_js_with_node_type_stripping.md for more details.

## AWS

#### Get a topics attributes (fg-gas-backend DEV)

Note that the SQS url http://sqs.eu-west-2.127.0.0.1:4566 will also work in the terminal

```bash
aws sns get-topic-attributes --topic-arn arn:aws:sns:eu-west-2:332499610595:grant_application_created
```

#### Get a queue attributes

```
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/create_new_case --attribute-names All
```

```
aws sqs get-queue-attributes \
  --queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/create_new_case-deadletter --attribute-names All
```

#### Send message to the grant_application_created topic

```
aws sns publish \
  --topic-arn "arn:aws:sns:eu-west-2:332499610595:grant_application_created" \
  --message '{"clientRef": "APPLICATION-REF-1", "code": "frps-private-beta", "createdAt": "2025-03-27T10:34:52.000Z", "submittedAt": "2025-03-28T11:30:52.000Z", "identifiers": { "sbi": "SBI001", "frn": "FIRM0001", "crn": "CUST0001", "defraId": "DEFRA0001" }, "answers": { "scheme": "SFI", "year": 2025, "hasCheckedLandIsUpToDate": true, "actionApplications": [ { "parcelId": "9238", "sheetId": "SX0679", "code": "CSAM1", "appliedFor": {"unit": "ha","quantity": 20.23 }}]}}'
```

#### Check the message has arrived in the queue

```
aws sqs receive-message \
--queue-url "https://sqs.eu-west-2.amazonaws.com/332499610595/create_new_case"
```

```
aws sqs receive-message \
--queue-url "https://sqs.eu-west-2.amazonaws.com/332499610595/create_new_case-deadletter"
```

#### Delete a message from the queue

```
aws sqs delete-message \
--queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/create_new_case --receipt-handle <receipt-handle>
```

#### Purge the queue

```
aws sqs purge-queue \
--queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/create_new_case
```

```
aws sqs purge-queue \
--queue-url https://sqs.eu-west-2.amazonaws.com/332499610595/create_new_case-deadletter
```

#### Test the dead letter queue

Send a message in and try to receive the message four times like so

```
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
```

## Docker

Launch CW and dependencies via Docker Compose:

```
docker compose up --watch --build
```

Check the container status in our system and see the container id's

```
docker ps -a
```

Run an interactive shell on a container

```
docker exec -it <container id> sh
```

## Local stack

### Useful commands

Docker compose uses [floci](https://floci.io) to replicate the aws environment.
Here are some useful commands for interacting with it. The image ships `awslocal`,
so these run inside the container: `docker compose exec floci <command>`.

#### List the topics

`awslocal sns list-topics`

#### Get a topics attributes

```bash
awslocal sns get-topic-attributes --topic-arn arn:aws:sns:eu-west-2:000000000000:grant_application_created
```

#### Get a queue attributes

```
awslocal sqs get-queue-attributes \
  --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case --attribute-names All
```

```
awslocal sqs get-queue-attributes \
  --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case-deadletter --attribute-names All
```

#### Send message to the grant_application_created topic

```
awslocal sns publish \
  --topic-arn "arn:aws:sns:eu-west-2:000000000000:grant_application_created" \
  --message '{"clientRef": "APPLICATION-REF-2",
  "code": "frps-private-beta",
  "createdAt": "2025-03-27T10:34:52.000Z",
  "submittedAt": "2025-03-28T11:30:52.000Z",
  "identifiers": {
    "sbi": "SBI001",
    "frn": "FIRM0001",
    "crn": "CUST0001",
    "defraId": "DEFRA0001"
  },
  "answers": {
    "scheme": "SFI",
    "year": 2025,
    "hasCheckedLandIsUpToDate": true,
    "actionApplications": [
      {
        "parcelId": "9238",
        "sheetId": "SX0679",
        "code": "CSAM1",
        "appliedFor": {
          "unit": "ha",
          "quantity": 20.23
        }
      }
    ]
  }
}'
```

#### Check the message has arrived in the queue

```
awslocal sqs receive-message \
--queue-url "http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case"
```

```
awslocal sqs receive-message \
--queue-url "http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case-deadletter"
```

#### Delete a message from the queue

```
awslocal sqs delete-message \
--queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case --receipt-handle <receipt-handle>
```

#### Purge the queue

```
awslocal sqs purge-queue \
--queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
```

#### Test the dead letter queue

Send a message in and try to receive the message four times like so

```
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
awslocal sqs receive-message --visibility-timeout 0 --queue-url http://sqs.eu-west-2.127.0.0.1:4566/000000000000/create_new_case
```

#### SQS Retry Mechanism

The application implements an automatic retry mechanism for failed SQS message processing:

1. When a message fails to process, it will be retried based on the `maxRetries` configuration (default: 3)
2. Each retry attempt uses exponential backoff (30s, 60s, 120s, etc.)
3. After all retry attempts are exhausted, the message is moved to the Dead Letter Queue (DLQ)
4. The retry count is tracked using SQS's built-in `ApproximateReceiveCount` attribute

To configure the maximum number of retries, set the `SQS_MAX_RETRIES` environment variable or update the default in `src/config.js`.

#### Move the DLQ messages back into the recovery queue

```
awslocal sqs start-message-move-task \
  --source-arn arn:aws:sqs:eu-west-2:000000000000:create_new_case-deadletter \
  --destination-arn arn:aws:sqs:eu-west-2:000000000000:create_new_case-recovery
```

Core delivery platform Node.js Backend Template.

- [Requirements](#requirements)
  - [Node.js](#nodejs)
- [Local development](#local-development)
  - [Setup](#setup)
  - [Development](#development)
  - [Testing](#testing)
  - [Production](#production)
  - [Npm scripts](#npm-scripts)
  - [Update dependencies](#update-dependencies)
  - [Formatting](#formatting)
    - [Windows prettier issue](#windows-prettier-issue)
- [API endpoints](#api-endpoints)
- [Development helpers](#development-helpers)
  - [MongoDB Locks](#mongodb-locks)
  - [Proxy](#proxy)
- [Docker](#docker)
  - [Development image](#development-image)
  - [Production image](#production-image)
  - [Docker Compose](#docker-compose)
  - [Dependabot](#dependabot)
  - [SonarCloud](#sonarcloud)
- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Requirements

### Node.js

Please install [Node.js](http://nodejs.org/) `>= v22` and [npm](https://nodejs.org/) `>= v11`. You will find it
easier to use the Node Version Manager [nvm](https://github.com/creationix/nvm)

To use the correct version of Node.js for this application, via nvm:

```bash
cd fg-cw-backend
nvm use
```

## Local development

**It's recommended if running with other services to use [fg-grants-core](https://github.com/DEFRA/fg-grants-core)**

### Setup

Install application dependencies:

```bash
npm install
```

### Development

To run the application in `development` mode run:

```bash
docker compose up --watch --build
```

### Testing

To test the application run:

```bash
npm run test
```

or (with coverage)

```bash
npm run coverage
```

To run integration tests:

```bash
npm run test:integration
```

### Production

To mimic the application running in `production` mode locally run:

```bash
npm start
```

### Npm scripts

All available Npm scripts can be seen in [package.json](./package.json).
To view them in your command line run:

```bash
npm run
```

#### Publish SQS messages

Create a new case:

```bash
npm run publish:case:new
```

### Update dependencies

To update dependencies use [npm-check-updates](https://github.com/raineorshine/npm-check-updates):

> The following script is a good start. Check out all the options on
> the [npm-check-updates](https://github.com/raineorshine/npm-check-updates)

```bash
ncu --interactive --format group
```

### Formatting

#### Windows prettier issue

If you are having issues with formatting of line breaks on Windows update your global git config by running:

```bash
git config --global core.autocrlf false
```

## API endpoints

The endpoint reference is the Swagger UI at `/documentation`, generated from
the route definitions.

## Two API surfaces

This service answers to two different callers, and which one an endpoint is for
decides how it is authenticated:

| Surface        | Called by                          | Strategy     | Credential                                    |
| :------------- | :--------------------------------- | :----------- | :-------------------------------------------- |
| **BFF**        | fg-cw-frontend                     | `entra`      | An Entra ID user token, verified against JWKS |
| **Public API** | Other backends, e.g fg-gas-backend | `public-api` | A service access token (see below)            |

The BFF surface is everything that existed before, and follows
[ADR-001](./docs/ADR/0001_use_backend_for_frontend_style.md): endpoints shaped
for a particular CW-FE view, free to change as that view changes. The public API
is the opposite - a contract other backends depend on. `/actuators/*` is the
service management subset of it.

`entra` stays the server default, so a route is on the BFF surface unless it
says otherwise, and no existing endpoint can start accepting a service token by
accident.

### Adding a public API endpoint

Declare the surface on the route itself:

```javascript
export const findQueueStatsRoute = {
  method: "GET",
  path: "/actuators/queue-stats",
  options: {
    auth: "public-api",
    tags: ["api", "public-api"],
    plugins: { "hapi-swagger": { security: [{ serviceToken: [] }] } },
  },
  // ...
};
```

`auth` puts the route on the service-token strategy, the `public-api` tag
separates it from the BFF surface in the docs, and the security block names the
credential in Swagger. The names are string literals because the ESLint layering
zones stop a file under `routes/` importing from `src/server/`.

Forgetting `auth` leaves the route on `entra`: a service caller gets a 401, but
the route is quietly exposed to the BFF surface - every logged-in CW user -
instead. The actuators module test guards against exactly that by asserting
every `/actuators/*` route sits on the `public-api` strategy.

### Service access tokens

The public API is for callers with no Entra user behind them, so it uses the
same credential scheme as fg-gas-backend's own service auth. Tokens are stored
in `access_tokens` as a SHA-256 hash of the raw value, so a leak of the
collection yields nothing that authenticates and this service can never mint or
impersonate a credential it accepts.

Deployed environments give nobody direct database access, so tokens are not
inserted by hand. The service seeds one itself on boot from
`SERVICE_ACCESS_TOKEN_HASH`, supplied by the platform's secret store, which makes
issuing and rotating a credential a secret change plus a redeploy.

The value is a single `client:sha256hex` pair:

```
fg-gas-backend:4bb35ade...
```

Only the hash reaches this service. The raw token lives solely in the calling
service's own secrets. Neither value belongs in a repository: this repo is
public, and callers' repos may be too.

This is an instruction to issue, not a record of who holds a token:

- It affects only the client it names. The secret names one client, and only
  that client's record is rewritten.
- Unset it and nothing happens. Clearing the secret revokes nobody, so it can be
  emptied once a credential has been issued.
- Onboard services one at a time: point it at the next client and redeploy. The
  previously issued token stays valid.

Seeding never stops the service starting. A malformed value or a database
failure is logged and skipped, leaving that client without a working token until
the next deploy, rather than taking the service down for everyone. Check the logs
after a deploy - a credential that silently never appeared looks exactly like one
that was never set.

#### Issue or rotate

Run once **per environment** - never reuse a token across environments, or a dev
credential authenticates against prod:

```bash
npm run token:new -- <client-name>
```

Then in the CDP portal for that environment:

1. `fg-cw-backend` -> Secrets -> `SERVICE_ACCESS_TOKEN_HASH` = the printed
   `client:hash` pair
2. Give the raw token to the calling service as its own secret
3. Redeploy `fg-cw-backend`, then the caller

Setting a new hash for a client that already has one rotates it: a single seeded
record per client is enforced by a unique index, so the new token replaces the
previous one on the next boot. Expect 401s between the two redeploys, so deploy
`fg-cw-backend` first.

Locally, set `SERVICE_ACCESS_TOKEN_HASH` in `.env` instead of the portal.

#### Revoke

There is no revoke-by-omission - clearing the secret deliberately does nothing.
To cut a client off, rotate it to a freshly generated hash and discard the raw
token: the old token stops working on the next boot and nobody holds the new one.
Removing the record outright needs database access. Issuing the new hash and
revoking the old one is a single atomic step, so confirm the deploy logged
`Seeded access token for <client>` - a failed seed leaves the old token live.

The client name is the identity, so renaming one issues a _second_ credential
rather than rotating the first, and the original stays valid indefinitely. Cut the old name off the same
way - point the secret at `<old-name>:<fresh hash>`, redeploy, and discard that
token - before switching to the new name.

#### Verify

Check the startup logs, which will show one of:

| Log line                                                                    | Meaning                                                                                                                  |
| :-------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `Seeded access token for <client>`                                          | Issued. A `, replacing the previous one` suffix means the hash changed; without it, the credential was already in place. |
| `SERVICE_ACCESS_TOKEN_HASH is not a client:sha256hex pair - nothing seeded` | The value is malformed. Nothing was issued or removed.                                                                   |
| `Failed to seed access token for <client>`                                  | The database write failed. The service started anyway; retry by redeploying.                                             |

Then call the endpoint with the raw token:

```bash
curl -H "Authorization: Bearer <raw-token>" http://localhost:3101/actuators/events
```

## Development helpers

### MongoDB Locks

If you require a write lock for Mongo you can acquire it via `server.locker` or `request.locker`:

```javascript
async function doStuff(server) {
  const lock = await server.locker.lock("unique-resource-name");

  if (!lock) {
    // Lock unavailable
    return;
  }

  try {
    // do stuff
  } finally {
    await lock.free();
  }
}
```

Keep it small and atomic.

You may use **using** for the lock resource management.
Note test coverage reports do not like that syntax.

```javascript
async function doStuff(server) {
  await using lock = await server.locker.lock("unique-resource-name");

  if (!lock) {
    // Lock unavailable
    return;
  }

  // do stuff

  // lock automatically released
}
```

Helper methods are also available in `/src/helpers/mongo-lock.js`.

## Logging

This application uses [Pino](https://getpino.io/) for structured logging, configured with ECS (Elastic Common Schema) formatting for better observability and log analysis.

Logging is configured in `src/common/logger.js`.

### Basic Logging

We use paired entry and exit logging patterns for better log correlation.

**Entry logs** indicate the start of an operation:

```javascript
logger.info(`Updating User "${userId}"`);
```

**Exit logs** indicate the completion of an operation:

```javascript
logger.info(`Finished: Updating User "${userId}"`);
```

> **Note**: We use consistent entry text to make it easier to correlate logs within OpenSearch.

### Conditional Logging

For operations that have conditional logic between entry and exit logs, use `logger.debug()` or `logger.info()` based on relevance:

```javascript
logger.debug(`Stored response for action "${actionCode}" for case "${caseId}"`);
```

**Example implementation**: See `src/users/use-cases/update-user.use-case.js`

### Log Levels

**Warning logs** for recoverable issues:

**Debug logs** for detailed diagnostic information:

> **Note**: Error logging (`logger.error`) is typically not required in use cases as errors are thrown and will propagate up the call stack where they can be handled and logged by the error handling middleware.

### Best Practices

- Include relevant identifiers (IDs, codes, references) in log messages when they must be searchable in OpenSearch
- CDP only indexes the supported ECS field subset, so unknown context-object properties are not available in OpenSearch
- Use context objects only for supported ECS fields such as `event.*` and `error.*`, or for diagnostics that do not need downstream search
- Keep entry and exit log messages consistent for easier correlation
- Use appropriate log levels based on the importance of the information

### Proxy

We are using forward-proxy which is set up by default. To make use of this: `import { fetch } from 'undici'` then
because of the `setGlobalDispatcher(new ProxyAgent(proxyUrl))` calls will use the ProxyAgent Dispatcher

If you are not using Wreck, Axios or Undici or a similar http that uses `Request`. Then you may have to provide the
proxy dispatcher:

To add the dispatcher to your own client:

```javascript
import { ProxyAgent } from "undici";

return await fetch(url, {
  dispatcher: new ProxyAgent({
    uri: proxyUrl,
    keepAliveTimeout: 10,
    keepAliveMaxTimeout: 10,
  }),
});
```

## Docker

### Development image

Build:

```bash
docker build --target development --no-cache --tag fg-cw-backend:development .
```

Run:

```bash
docker run -e PORT=3001 -p 3001:3001 fg-cw-backend:development
```

### Production image

Build:

```bash
docker build --no-cache --tag fg-cw-backend .
```

Run:

```bash
docker run -e PORT=3001 -p 3001:3001 fg-cw-backend
```

### Docker Compose

A local environment with:

- floci for AWS services (S3, SQS)
- MongoDB
- This service.
- A commented out frontend example.

```bash
docker compose up --build -d
```

### Dependabot

We have added an example dependabot configuration file to the repository. You can enable it by renaming
the [.github/example.dependabot.yml](.github/dependabot.yml) to `.github/dependabot.yml`

### SonarCloud

Instructions for setting up SonarCloud can be found in [sonar-project.properties](./sonar-project.properties)

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government license v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
