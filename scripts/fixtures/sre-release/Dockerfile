FROM node:22-alpine
ARG REVISION=v1
ARG FAIL=0
ENV FIXTURE_REVISION=$REVISION FIXTURE_FAIL=$FAIL
WORKDIR /fixture
COPY app.cjs /fixture/app.cjs
USER node
ENTRYPOINT ["node", "/fixture/app.cjs"]
