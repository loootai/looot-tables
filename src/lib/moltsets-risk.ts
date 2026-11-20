import type { MoltSetsCallMeta } from './types';

/** MoltSets email risk scores. A to F grade send safety (will the mailbox accept mail), not whether the address belongs
    to the person looked up. */
export type RiskScore = NonNullable<MoltSetsCallMeta['riskScore']>;

export type RiskTone = 'good' | 'caution' | 'bad' | 'none';

const GRADES: readonly RiskScore[] = ['A', 'B', 'C', 'D', 'F'];

/** The grade MoltSets returned. A missing or unknown grade is F: MoltSets says to treat an absent grade that way. */
export function riskGrade(value: unknown): RiskScore {
	const grade = typeof value === 'string' ? value.trim().toUpperCase() : '';
	return (GRADES as readonly string[]).includes(grade) ? (grade as RiskScore) : 'F';
}

/** A and B are green, C (catch-all, deliverability unknowable) is amber, D (a known bad address) is red, F (no signal) is grey. */
export function riskTone(grade: RiskScore): RiskTone {
	if (grade === 'A' || grade === 'B') return 'good';
	if (grade === 'C') return 'caution';
	if (grade === 'D') return 'bad';
	return 'none';
}

export const RISK_MEANING: Record<RiskScore, string> = {
	A: 'Validated deliverable',
	B: 'Known engagement: a past open, click or order reached this mailbox',
	C: 'Catch-all domain, deliverability unknowable',
	D: 'Known bad: spam trap, abuse, do-not-mail or a recent complaint',
	F: 'No signal either way',
};

/** The tooltip of a risk badge: the grade in words, and when MoltSets last validated the address. */
export function riskTitle(grade: RiskScore, validatedAt?: string): string {
	return `MoltSets risk ${grade}: ${RISK_MEANING[grade]}${validatedAt ? `. Last validated ${validatedAt.slice(0, 10)}.` : '.'}`;
}
