FROM alpine:3.21
RUN apk add --no-cache curl jq bash
COPY tools/seed-conditions/seed.sh /usr/local/bin/seed.sh
RUN chmod +x /usr/local/bin/seed.sh
ENTRYPOINT ["seed.sh"]
