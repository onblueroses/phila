"""Build the Kaggle kernel script by embedding actual phila source files as base64."""
import base64
import os

os.chdir(os.path.join(os.path.dirname(__file__), '..'))

def read(path):
    with open(path) as f:
        return f.read()

def b64(content):
    return base64.b64encode(content.encode()).decode()

sources = {
    'src/types.ts': read('src/types.ts'),
    'src/voice.ts': read('src/voice.ts'),
    'src/gate.ts': read('src/gate.ts'),
    'test/scenarios.ts': read('test/scenarios.ts'),
    'test/scorer.ts': read('test/scorer.ts'),
    'test/inference.ts': read('test/inference.ts'),
    'test/cross-validation.ts': read('test/cross-validation.ts'),
    'test/continuous-optimize.ts': read('test/continuous-optimize.ts'),
}

ollama_stub = (
    "import type { PhilaConfig } from './types.ts'\n"
    "\n"
    "export async function chat(_system: string, _user: string, _config: PhilaConfig): Promise<string> {\n"
    "  throw new Error('chat() stub - use infer() in continuous-optimize.ts instead')\n"
    "}\n"
)

package_json = (
    '{\n'
    '  "name": "phila",\n'
    '  "version": "0.1.0",\n'
    '  "type": "module",\n'
    '  "scripts": {\n'
    '    "test": "node --experimental-strip-types --test test/*.test.ts"\n'
    '  },\n'
    '  "engines": { "node": ">=22.6.0" }\n'
    '}\n'
)

# Build file write statements
file_writes = []
all_files = {'package.json': package_json, 'src/ollama.ts': ollama_stub}
all_files.update(sources)

for path, content in all_files.items():
    encoded = b64(content)
    file_writes.append(
        f'with open(f"{{WORKDIR}}/{path}", "wb") as f:\n'
        f'    f.write(base64.b64decode("{encoded}"))\n'
    )

file_writes_str = '\n'.join(file_writes)

script = f'''"""
Kaggle kernel: phila GPU optimizer.
Installs Node 22 + Ollama, writes phila source files, runs the optimizer with T4 GPU.
"""
import subprocess
import os
import shutil
import base64

def run(cmd, check=True, **kwargs):
    print(f"$ {{cmd}}")
    result = subprocess.run(cmd, shell=True, check=check, capture_output=False, **kwargs)
    return result

WORKDIR = "/kaggle/working/phila"

print("=== Installing Node 22 ===")
run("curl -fsSL https://deb.nodesource.com/setup_22.x | bash -")
run("apt-get install -y nodejs")
run("node --version")

print("=== Installing Ollama ===")
run("apt-get install -y zstd")
run("curl -fsSL https://ollama.com/install.sh | sh")
print("Starting Ollama server...")
subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
import time; time.sleep(5)

print("Pulling llama3.2...")
run("ollama pull llama3.2")

print("=== Writing phila source files ===")
os.makedirs(f"{{WORKDIR}}/src", exist_ok=True)
os.makedirs(f"{{WORKDIR}}/test", exist_ok=True)

{file_writes_str}

print(f"=== All files written to {{WORKDIR}} ===")
print("File listing:")
for root, dirs, files in os.walk(WORKDIR):
    for f in files:
        path = os.path.join(root, f)
        size = os.path.getsize(path)
        print(f"  {{os.path.relpath(path, WORKDIR)}} ({{size}} bytes)")

print("=== Running optimizer: 3 runs x infinite generations (until timeout) ===")
os.chdir(WORKDIR)
result = run(
    "node --experimental-strip-types test/continuous-optimize.ts --runs 3 --generations 0 --no-cv",
    check=False,
)
print(f"Optimizer exited with code {{result.returncode}}")

if os.path.exists("test/checkpoint.json"):
    shutil.copy("test/checkpoint.json", "/kaggle/working/checkpoint.json")
    print("Checkpoint saved to /kaggle/working/checkpoint.json")
'''

output_path = 'test/kaggle-kernel/script.py'
with open(output_path, 'w', newline='\n') as f:
    f.write(script)

# Verify
compile(script, output_path, 'exec')
print(f"Generated {output_path}: {len(script)} chars - compiles OK")
