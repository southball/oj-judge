FROM node:12

RUN apt-get update && apt-get install -y libcap-dev make git
WORKDIR /app

RUN git clone https://github.com/ioi/isolate/ isolate
RUN cd isolate && make install

RUN yarn global add nodemon
RUN apt-get update && apt-get install -y g++

COPY package.json package.json
RUN yarn

COPY . .

ENTRYPOINT ["sh", "-c", "nodemon --delay 1000ms judge.js"]