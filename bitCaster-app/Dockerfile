FROM node:24-alpine AS build
WORKDIR /app
COPY bitCaster-app/package.json bitCaster-app/package-lock.json* ./
RUN npm ci
COPY bitCaster-app/ .
ARG VITE_MINT_URL=http://localhost:8085
ARG VITE_SERVER_URL=http://localhost:5000
ENV VITE_MINT_URL=$VITE_MINT_URL
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY bitCaster-app/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
