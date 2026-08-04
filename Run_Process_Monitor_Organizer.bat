@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYTHON_CMD=py"
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PYTHON_CMD=python"
    ) else (
        echo Python is not installed or is not available in PATH.
        echo Install Python 3 from https://www.python.org/downloads/windows/
        echo During installation, select "Add python.exe to PATH".
        pause
        exit /b 1
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo First run: creating the local environment...
    %PYTHON_CMD% -m venv .venv
    if errorlevel 1 goto :failed
)

call ".venv\Scripts\activate.bat"
python -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto :failed
python main.py
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo The organizer could not start. Review the message above.
pause
exit /b 1
