FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache ca-certificates


# Copy the manifest we just created
COPY package.json ./

# Install the dependencies (express, pg, etc.)
RUN npm install

# Copy everything else (public folder, server.js)
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]