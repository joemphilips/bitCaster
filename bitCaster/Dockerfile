FROM node:24-alpine AS build
WORKDIR /app
COPY bitCaster/package.json bitCaster/package-lock.json* ./
RUN npm ci
COPY bitCaster/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY bitCaster/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
