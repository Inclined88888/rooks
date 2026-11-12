

export const BUDGET_STEPS = { low: 2_000, medium: 8_000, high: 32_000 };

const CLI_MIN_BUDGET = 1_024;
const CAPABILITIES_ENV = 'CLAUDE_CODE_MODEL_CAPABILITIES';
const BUDGET_ENV = 'MAX_THINKING_TOKENS';

const BUDGET_CAPABILITIES = '-adaptive_thinking,-effort';

const LEVEL_CAPABILITIES = 'effort,max_effort,xhigh_effort';
const OFF_VALUES = new Set(['off', 'none', 'disabled', 'false', '0']);
const STEP_OF = {
    minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

export function claudeThinkingControl(reasoning) {
    if (!reasoning?.thinks || !reasoning.controls.length)
        return null;
    const find = (type) => reasoning.controls.find((control) => control.type === type) ?? null;





    if (reasoning.source !== 'catalog')
        return find('levels') ?? find('budget') ?? find('toggle');
    return find('budget') ?? find('levels') ?? find('toggle');
}
function budgetOf(value, control) {
    if (OFF_VALUES.has(value))
        return 0;
    const step = STEP_OF[value];
    const raw = step ? BUDGET_STEPS[step] : /^\d+$/.test(value) ? Number(value) : null;
    if (raw === null)
        return null;
    if (raw === 0)
        return 0;
    const floor = Math.max(CLI_MIN_BUDGET, control.min ?? 0);
    return Math.max(floor, control.max !== undefined ? Math.min(raw, control.max) : raw);
}

export function claudeThinking(effort, reasoning) {
    const value = effort?.trim().toLowerCase() ?? '';
    const control = claudeThinkingControl(reasoning);
    if (!control && reasoning && reasoning.source !== 'catalog')
        return { args: [], env: {} };
    if (!control)
        return { args: effort ? ['--effort', effort] : [], env: {} };
    if (!value)
        return { args: [], env: {} };
    if (control.type === 'levels') {

        if (/^\d+$/.test(value))
            return { args: [], env: {} };
        return { args: ['--effort', effort.trim()], env: { [CAPABILITIES_ENV]: LEVEL_CAPABILITIES } };
    }
    if (control.type === 'budget') {
        const budget = budgetOf(value, control);
        if (budget === null)
            return { args: [], env: {} };
        return { args: [], env: { [CAPABILITIES_ENV]: BUDGET_CAPABILITIES, [BUDGET_ENV]: String(budget) } };
    }

    return {
        args: [],
        env: { [CAPABILITIES_ENV]: BUDGET_CAPABILITIES, ...(OFF_VALUES.has(value) ? { [BUDGET_ENV]: '0' } : {}) },
    };
}
