@echo off
set PATH=%~dp0node;%PATH%
%~dp0node\npm.cmd run simulate -- --strategy cheapest --objective timeLimit --target 4500 --verbose