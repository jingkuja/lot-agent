#!/bin/sh
set -e
# 后台启动机器信息服务(仅容器内 127.0.0.1:8080,不对外 EXPOSE)
/usr/local/bin/agender &
# 前台交给 nginx 官方 entrypoint,保留基础镜像的模板/初始化行为
exec /docker-entrypoint.sh nginx -g 'daemon off;'
