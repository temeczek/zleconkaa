FROM node:22-slim
WORKDIR /app
COPY package.json server.js backup.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/zlecenka.db
VOLUME /data
EXPOSE 3000
CMD ["node","--disable-warning=ExperimentalWarning","server.js"]
