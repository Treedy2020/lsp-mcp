import { z } from 'zod';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findProjectRoot } from '../utils/position.js';

export const statusSchema = {
  file: z.string().describe('A Python file path to check the project status for'),
};

type StatusArgs = {
  file: string;
};

export async function status(args: StatusArgs): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { file } = args;
  const lines: string[] = [];

  // Find project root
  const projectRoot = findProjectRoot(file);
  lines.push(`## Project Root`);
  lines.push(`\`${projectRoot}\``);
  lines.push('');

  // Check pyright installation
  lines.push(`## Pyright`);
  try {
    const pyrightVersion = execSync('pyright --version', { encoding: 'utf-8' }).trim();
    lines.push(`- Version: ${pyrightVersion}`);
  } catch {
    lines.push(`- ⚠️ **Not installed or not in PATH**`);
    lines.push(`  Install with: \`npm install -g pyright\``);
  }
  lines.push('');

  // Check pyright config
  lines.push(`## Pyright Config`);
  const pyrightConfigPath = join(projectRoot, 'pyrightconfig.json');
  const pyprojectPath = join(projectRoot, 'pyproject.toml');

  if (existsSync(pyrightConfigPath)) {
    lines.push(`- Config file: \`pyrightconfig.json\``);
    try {
      const config = JSON.parse(readFileSync(pyrightConfigPath, 'utf-8'));
      if (config.pythonVersion) {
        lines.push(`- Python version: ${config.pythonVersion}`);
      }
      if (config.pythonPlatform) {
        lines.push(`- Platform: ${config.pythonPlatform}`);
      }
      if (config.venvPath) {
        lines.push(`- Venv path: ${config.venvPath}`);
      }
      if (config.venv) {
        lines.push(`- Venv: ${config.venv}`);
      }
      if (config.typeCheckingMode) {
        lines.push(`- Type checking mode: ${config.typeCheckingMode}`);
      }
      if (config.include) {
        lines.push(`- Include: ${JSON.stringify(config.include)}`);
      }
      if (config.exclude) {
        lines.push(`- Exclude: ${JSON.stringify(config.exclude)}`);
      }
    } catch (e) {
      lines.push(`- ⚠️ Failed to parse config: ${e}`);
    }
  } else if (existsSync(pyprojectPath)) {
    lines.push(`- Config file: \`pyproject.toml\` (may contain [tool.pyright] section)`);
  } else {
    lines.push(`- ⚠️ No pyrightconfig.json or pyproject.toml found`);
    lines.push(`  Pyright will use default settings`);
  }
  lines.push('');

  // Check Python environment
  lines.push(`## Python Environment`);
  try {
    const pythonVersion = execSync('python3 --version', { encoding: 'utf-8' }).trim();
    lines.push(`- System Python: ${pythonVersion}`);
  } catch {
    try {
      const pythonVersion = execSync('python --version', { encoding: 'utf-8' }).trim();
      lines.push(`- System Python: ${pythonVersion}`);
    } catch {
      lines.push(`- ⚠️ Python not found in PATH`);
    }
  }

  // Check for virtual environment
  const venvPaths = ['.venv', 'venv', '.env', 'env'];
  for (const venv of venvPaths) {
    const venvPath = join(projectRoot, venv);
    if (existsSync(venvPath)) {
      lines.push(`- Virtual env found: \`${venv}/\``);
      // Try to get venv python version
      const venvPython = join(venvPath, 'bin', 'python');
      if (existsSync(venvPython)) {
        try {
          const venvVersion = execSync(`"${venvPython}" --version`, { encoding: 'utf-8' }).trim();
          lines.push(`  - ${venvVersion}`);
        } catch {
          // ignore
        }
      }
      break;
    }
  }
  lines.push('');

  // Quick pyright check on the file
  lines.push(`## File Check`);
  lines.push(`- File: \`${file}\``);
  if (existsSync(file)) {
    lines.push(`- Exists: ✅`);
    try {
      const result = execSync(`pyright "${file}" --outputjson`, {
        encoding: 'utf-8',
        cwd: projectRoot,
        timeout: 30000,
      });
      const output = JSON.parse(result);
      const errors = output.generalDiagnostics?.filter((d: { severity: string }) => d.severity === 'error')?.length || 0;
      const warnings = output.generalDiagnostics?.filter((d: { severity: string }) => d.severity === 'warning')?.length || 0;
      lines.push(`- Diagnostics: ${errors} errors, ${warnings} warnings`);
    } catch (e: unknown) {
      // pyright returns non-zero exit code if there are errors
      const error = e as { stdout?: string };
      if (error.stdout) {
        try {
          const output = JSON.parse(error.stdout);
          const errors = output.generalDiagnostics?.filter((d: { severity: string }) => d.severity === 'error')?.length || 0;
          const warnings = output.generalDiagnostics?.filter((d: { severity: string }) => d.severity === 'warning')?.length || 0;
          lines.push(`- Diagnostics: ${errors} errors, ${warnings} warnings`);
        } catch {
          lines.push(`- ⚠️ Could not run pyright check`);
        }
      } else {
        lines.push(`- ⚠️ Could not run pyright check`);
      }
    }
  } else {
    lines.push(`- Exists: ❌ File not found`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}
