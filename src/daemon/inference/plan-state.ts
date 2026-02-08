/**
 * Plan state for iterative execution.
 */
export class PlanState {
  private steps: string[] = [];
  private currentStepIndex = 0;

  reset(): void {
    this.steps = [];
    this.currentStepIndex = 0;
  }

  isActive(): boolean {
    return this.steps.length > 0;
  }

  getCurrentStepDirective(): string | undefined {
    if (!this.isActive()) return undefined;
    if (this.currentStepIndex >= this.steps.length) return undefined;

    const stepNum = this.currentStepIndex + 1;
    const totalSteps = this.steps.length;
    const currentStep = this.steps[this.currentStepIndex]!;

    return (
      `[Step ${stepNum}/${totalSteps}] Focus ONLY on this step now: ${currentStep}` +
      `\n\nComplete this step, then call task_complete. Do not work on any other steps.`
    );
  }

  activate(steps: string[]): string {
    this.steps = Array.isArray(steps) ? steps : [];
    this.currentStepIndex = 0;
    return `Plan activated with ${this.steps.length} steps:\n${this.steps
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n")}`;
  }

  hasMoreSteps(): boolean {
    return this.steps.length > 0 && this.currentStepIndex < this.steps.length - 1;
  }

  advance(): { completedStep: number; nextStep: number; totalSteps: number; summary: string } {
    const completedStep = this.currentStepIndex + 1;
    this.currentStepIndex++;
    const nextStep = this.currentStepIndex + 1;
    const totalSteps = this.steps.length;
    const summary = `Completed step ${completedStep}/${totalSteps}. Now on step ${nextStep}.`;
    return { completedStep, nextStep, totalSteps, summary };
  }

  getTotalSteps(): number {
    return this.steps.length;
  }

  getCurrentStepNumber(): number {
    return this.currentStepIndex + 1;
  }
}
