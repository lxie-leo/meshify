@echo off
rem meshify root launcher (Windows); see bin\_bootstrap.mjs
set "DIR=%~dp0"
node "%DIR%_bootstrap.mjs" %*
