FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
RUN chown node:node /app
USER node
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
