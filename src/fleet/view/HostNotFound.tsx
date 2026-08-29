import { ArrowLeft, ServerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../shared/view/ui';

const MAX_DISPLAYED_HOST_LENGTH = 64;

/**
 * Dead end for a session URL whose host segment is not a host this hub can
 * resolve. It deliberately offers no way to "just open the session anyway": the
 * same local session id exists on other installations, so a fallback would open
 * the wrong machine's conversation.
 */
export default function HostNotFound({ requestedHostId }: { requestedHostId: string }) {
  const { t } = useTranslation('common');
  const displayedHostId = requestedHostId.length > MAX_DISPLAYED_HOST_LENGTH
    ? `${requestedHostId.slice(0, MAX_DISPLAYED_HOST_LENGTH)}…`
    : requestedHostId;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-3 p-6 pb-3">
          <span
            aria-hidden="true"
            className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <ServerOff className="size-5" />
          </span>
          <CardTitle className="text-lg font-semibold tracking-tight">
            {t('fleet.hostNotFound.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 p-6 pt-0">
          <p className="break-keep text-sm leading-relaxed text-muted-foreground">
            {t('fleet.hostNotFound.description')}
          </p>
          <Alert variant="destructive" className="break-keep">
            <ServerOff aria-hidden="true" />
            <AlertTitle>{t('fleet.hostNotFound.requestedHost')}</AlertTitle>
            <AlertDescription>
              <code
                className="block break-all font-mono text-xs"
                data-testid="host-not-found-host-id"
              >
                {displayedHostId}
              </code>
            </AlertDescription>
          </Alert>
          <Link to="/" className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
            <ArrowLeft aria-hidden="true" />
            {t('fleet.hostNotFound.backToSessions')}
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
