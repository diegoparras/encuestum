FROM node:20-alpine

WORKDIR /app

# NEXT_PUBLIC_* values are inlined at build time, so the API URL must be known
# when `next build` runs. Override it with a build arg in docker-compose.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
