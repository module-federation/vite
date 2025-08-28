from node:20.19.0-alphine as ui-build

workdir /app

env PATH /app/node_modules/.bin:$PATH

COPY ./package.json /app

RUN npm install --silent 

COPY . .

RUN npm run build

FROM nginx:1.23.1-alphine

EXPOSE 80

COPY ./nginx/root.conf /etc/nginx/root.conf

COPY --from=ui-build /app/build /usr/share/nginx/html

CMD['nginx', '-g', 'daemon off;']