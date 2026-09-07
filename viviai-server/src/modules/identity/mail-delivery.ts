import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../../config.js';
export const MAIL_DELIVERY = Symbol('MAIL_DELIVERY');
export interface ChallengeMail {
  email: string;
  purpose: string;
  code: string;
}
export interface MailDelivery {
  sendChallenge(mail: ChallengeMail): Promise<void>;
}
export class DevelopmentMailbox implements MailDelivery {
  constructor(private readonly root: string) {}
  async sendChallenge(mail: ChallengeMail): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await writeFile(join(this.root, `${randomUUID()}.json`), JSON.stringify(mail), {
      mode: 0o600,
      flag: 'wx',
    });
  }
}
export function createMailDelivery(config: AppConfig): MailDelivery {
  if (config.devMailEnabled && config.nodeEnv !== 'production')
    return new DevelopmentMailbox(config.devMailboxRoot);
  if (!config.smtpUrl || !config.mailFrom)
    return {
      async sendChallenge() {
        throw new Error('Mail transport unavailable');
      },
    };
  const transport = nodemailer.createTransport(config.smtpUrl);
  const from = config.mailFrom;
  return {
    async sendChallenge(mail) {
      await transport.sendMail({
        from,
        to: mail.email,
        subject: 'VIVIAI verification code',
        text: `Your ${mail.purpose} code is ${mail.code}. It expires in 10 minutes.`,
      });
    },
  };
}
