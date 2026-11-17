FROM node:22-alpine
WORKDIR /fixture
RUN npm install --omit=dev --ignore-scripts pg@8.16.3 mysql2@3.15.3
COPY app.cjs /fixture/app.cjs
USER node
ENTRYPOINT ["node"]
CMD ["/fixture/app.cjs"]
