/**
 * Logger utility for CLI
 * Handles verbose mode, colors, and spinners
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";

export class Logger {
  private verbose: boolean;
  private spinner: Ora | null = null;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  /**
   * Log debug information (only in verbose mode)
   */
  debug(message: string): void {
    if (this.verbose) {
      console.log(chalk.gray(`[DEBUG] ${message}`));
    }
  }

  /**
   * Log informational message
   */
  info(message: string): void {
    console.log(chalk.blue(message));
  }

  /**
   * Log success message
   */
  success(message: string): void {
    console.log(chalk.green(`✓ ${message}`));
  }

  /**
   * Log error message
   */
  error(message: string): void {
    console.error(chalk.red(`✗ ${message}`));
  }

  /**
   * Log warning message
   */
  warn(message: string): void {
    console.warn(chalk.yellow(`⚠ ${message}`));
  }

  /**
   * Start a spinner with a message
   */
  startSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.stop();
    }
    
    if (!this.verbose) {
      this.spinner = ora({
        text: message,
        color: "cyan",
      }).start();
    } else {
      // In verbose mode, just log the message
      this.info(message);
    }
  }

  /**
   * Update spinner text
   */
  updateSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.text = message;
    } else if (this.verbose) {
      this.info(message);
    }
  }

  /**
   * Stop spinner with success
   */
  succeedSpinner(message?: string): void {
    if (this.spinner) {
      if (message) {
        this.spinner.succeed(message);
      } else {
        this.spinner.succeed();
      }
      this.spinner = null;
    } else if (this.verbose && message) {
      this.success(message);
    }
  }

  /**
   * Stop spinner with failure
   */
  failSpinner(message?: string): void {
    if (this.spinner) {
      if (message) {
        this.spinner.fail(message);
      } else {
        this.spinner.fail();
      }
      this.spinner = null;
    } else if (this.verbose && message) {
      this.error(message);
    }
  }

  /**
   * Stop spinner without status
   */
  stopSpinner(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  /**
   * Log agent thinking (only in verbose mode)
   */
  thinking(message: string): void {
    if (this.verbose) {
      console.log(chalk.cyan(`[Claude] ${message}`));
    }
  }

  /**
   * Log tool execution (only in verbose mode)
   */
  tool(name: string, input: unknown): void {
    if (this.verbose) {
      console.log(chalk.magenta(`[Tool] ${name}(${JSON.stringify(input)})`));
    }
  }

  /**
   * Log tool result (only in verbose mode)
   */
  toolResult(name: string, preview: string): void {
    if (this.verbose) {
      console.log(chalk.gray(`[Result] ${name}: ${preview}`));
    }
  }

  /**
   * Log iteration progress (only in verbose mode)
   */
  iteration(current: number, max: number): void {
    if (this.verbose) {
      console.log(chalk.yellow(`\n[Iteration ${current}/${max}]`));
    }
  }

  /**
   * Force log a message (ignores verbose mode)
   */
  log(message: string): void {
    console.log(message);
  }
}

// Global logger instance
let globalLogger: Logger | null = null;

/**
 * Initialize global logger
 */
export function initLogger(verbose: boolean = false): Logger {
  globalLogger = new Logger(verbose);
  return globalLogger;
}

/**
 * Get the global logger instance
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger(false);
  }
  return globalLogger;
}
