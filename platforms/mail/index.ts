/**
 * Mail (Gmail) platform — re-exports the CLI parsers so the top-level
 * dispatcher can register them under `messagemon mail …`.
 */
export { parseMailCli, configureMailCli } from "./mail"
export { parseAuthCli, configureAuthCli } from "./auth"
export { parseAccountsCli, configureAccountsCli } from "./accounts"
export { toUnifiedMessage } from "./toUnifiedMessage"
export { mailSource, markMailRead, fetchMailAttachment } from "./MailSource"
