type CronField = {
  expression: string;
  min: number;
  max: number;
  dayOfWeek?: boolean;
};

const CRON_FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7, dayOfWeek: true }
] as const;

const normalizeDayOfWeek = (value: number, dayOfWeek?: boolean) =>
  dayOfWeek && value === 7 ? 0 : value;

const parsePositiveInteger = (value: string, field: CronField) => {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid cron field "${field.expression}".`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
    throw new Error(`Cron field "${field.expression}" must be between ${field.min} and ${field.max}.`);
  }
  return parsed;
};

const addRange = (
  values: Set<number>,
  field: CronField,
  start: number,
  end: number,
  step = 1
) => {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Cron field "${field.expression}" has an invalid step.`);
  }
  if (start > end) {
    throw new Error(`Cron field "${field.expression}" has an invalid range.`);
  }
  for (let value = start; value <= end; value += step) {
    values.add(normalizeDayOfWeek(value, field.dayOfWeek));
  }
};

const parseCronField = (expression: string, range: Omit<CronField, "expression">) => {
  const field: CronField = { expression, ...range };
  const values = new Set<number>();
  const parts = expression.split(",");
  if (parts.some((part) => !part)) throw new Error(`Invalid cron field "${expression}".`);

  for (const part of parts) {
    const [base, rawStep, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`Invalid cron field "${expression}".`);
    const step = rawStep === undefined ? 1 : parsePositiveInteger(rawStep, field);
    if (base === "*") {
      addRange(values, field, field.min, field.max, step);
      continue;
    }
    const [rawStart, rawEnd, rangeExtra] = base.split("-");
    if (!rawStart || rangeExtra !== undefined) throw new Error(`Invalid cron field "${expression}".`);
    const start = parsePositiveInteger(rawStart, field);
    if (rawEnd === undefined) {
      if (rawStep !== undefined) throw new Error(`Cron field "${expression}" can only step ranges or *.`);
      values.add(normalizeDayOfWeek(start, field.dayOfWeek));
      continue;
    }
    const end = parsePositiveInteger(rawEnd, field);
    addRange(values, field, start, end, step);
  }

  return values;
};

export const normalizeCronExpression = (expression: string) => {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== 5 || fields.some((field) => !field)) {
    throw new Error("Cron expressions must have five fields.");
  }
  fields.forEach((field, index) => parseCronField(field, CRON_FIELD_RANGES[index]));
  return normalized;
};

export const isCronExpressionDue = (expression: string, date: Date) => {
  const normalized = normalizeCronExpression(expression);
  const fields = normalized.split(" ");
  const values = fields.map((field, index) =>
    parseCronField(field, CRON_FIELD_RANGES[index])
  );
  const actual = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay()
  ];
  return values.every((fieldValues, index) => fieldValues.has(actual[index]));
};

export const scheduledMinuteIso = (scheduledTime: number | Date) => {
  const millis = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  return new Date(Math.floor(millis / 60000) * 60000).toISOString();
};
