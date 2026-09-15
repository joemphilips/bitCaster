FROM node:22-alpine
RUN apk add --no-cache curl jq bash

WORKDIR /opt/bitcaster

# The registration helper uses the repository's Cashu fork and shared SDK
# parsers. Install only the runtime package and copy the source modules it
# imports. The image does not need the daemon's long-running service.
COPY cashu-ts/package.json cashu-ts/package.json
COPY cashu-ts/lib cashu-ts/lib
RUN npm install --no-save --omit=dev --ignore-scripts ./cashu-ts

COPY bitcaster-client-sdk/src/ctfRegistration.ts bitcaster-client-sdk/src/ctfRegistration.ts
COPY bitcaster-client-sdk/src/outcomeSets.ts bitcaster-client-sdk/src/outcomeSets.ts
COPY bitcaster-client-sdk/src/proofSelection.ts bitcaster-client-sdk/src/proofSelection.ts
COPY bitcaster-daemon/scripts/register-condition.ts bitcaster-daemon/scripts/register-condition.ts
COPY tools/seed-conditions/seed.sh /usr/local/bin/seed.sh
RUN chmod +x /usr/local/bin/seed.sh
ENTRYPOINT ["seed.sh"]
