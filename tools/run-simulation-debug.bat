@echo off
rem Debug-mode launcher for the simulation runner. Node is vendored, so it goes
rem on PATH here; js-debug cannot attach to npm (see .vscode/launch.json, which
rem launches node.exe --import tsx directly so breakpoints bind in tools/*.ts).
set PATH=%~dp0node;%PATH%
%~dp0node\npm.cmd run simulate -- --strategy cheapest --objective timeLimit --target 4500 --verbose