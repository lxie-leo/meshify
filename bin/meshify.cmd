@echo off
rem meshify root launcher (Windows); see bin\_bootstrap.js
set "DIR=%~dp0"
node "%DIR%_bootstrap.js" %*
