@echo off
set PATH=D:\work\dev\idle-civ\tools\node;%PATH%
cd /d D:\work\dev\idle-civ
node.exe npx tsx tools/simulation/run-age2-benchmark.mjs --max-time=36000
