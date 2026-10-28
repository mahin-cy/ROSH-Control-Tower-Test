import * as React from 'react';

import { cn } from '@/lib/utils';

// Plain native <label> rather than pulling in @radix-ui/react-label — a
// native label with htmlFor already gives click-passthrough to its
// associated control, which is Radix's Label's main value-add; not worth
// a new dependency for a form this simple.
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}

export { Label };
