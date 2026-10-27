#!/bin/bash
# Installs everything the engine needs into a Vercel Sandbox (Ubuntu image).
# Used to build the base snapshot, and as a fallback when no snapshot is configured.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ffmpeg python3-opencv python3-numpy curl
pip3 install --break-system-packages -q onnxruntime
mkdir -p /opt/models /opt/uploader
[ -f /opt/models/isnet-general-use.onnx ] || \
  curl -sSL -o /opt/models/isnet-general-use.onnx \
  https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
cd /opt/uploader
[ -f package.json ] || npm init -y > /dev/null
[ -d node_modules/@vercel/blob ] || npm i --silent @vercel/blob@2
chmod -R a+rwX /opt/uploader /opt/models
echo "setup done"
