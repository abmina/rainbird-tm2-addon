ARG BUILD_FROM
FROM ${BUILD_FROM}

# Node.js only - the add-on has no npm dependencies.
RUN apk add --no-cache nodejs tzdata icu-data-full

WORKDIR /app
COPY app/package.json ./
COPY app/src ./src
COPY app/www ./www
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
