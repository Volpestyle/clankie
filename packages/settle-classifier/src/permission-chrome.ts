import { normalizeScreenText } from "./screen.ts";

const PERMISSION_QUESTION = [
  /(?:do you want to|would you like to)\s+(?:allow|approve|run|execute|continue|proceed)/i,
  /(?:allow|approve|grant)\s+(?:this\s+)?(?:command|action|tool|request|operation)/i,
  /(?:permission|approval)\s+(?:is\s+)?required/i,
];

const PERMISSION_CHOICES = [
  /(?:yes|allow|approve|proceed)[\s\S]{0,500}(?:no|deny|reject|cancel)/i,
  /(?:no|deny|reject|cancel)[\s\S]{0,500}(?:yes|allow|approve|proceed)/i,
  /\[[yY]\s*\/\s*[nN]\]/,
];

/** Strict visible-chrome heuristic; prose questions without choice chrome go to the classifier. */
export function hasVisiblePermissionChrome(screenText: string): boolean {
  const tail = normalizeScreenText(screenText).split("\n").slice(-30).join("\n");
  return (
    PERMISSION_QUESTION.some((pattern) => pattern.test(tail)) &&
    PERMISSION_CHOICES.some((pattern) => pattern.test(tail))
  );
}
