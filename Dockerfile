FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --omit=dev
COPY . .
EXPOSE 8787
ENV PORT=8787
CMD ["node", "local/server.js"]
