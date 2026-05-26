FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.html styles.css app.js storage.js server.js ./
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "server.js"]
