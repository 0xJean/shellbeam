import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium cursor-pointer select-none transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-white shadow-sm hover:bg-primary/85 hover:shadow active:bg-primary/75 active:shadow-none',
        destructive: 'bg-destructive text-white shadow-sm hover:bg-destructive/85 hover:shadow active:bg-destructive/75 active:shadow-none',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/70 active:bg-secondary/55 active:shadow-none',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-accent/70',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground active:bg-accent/70 active:shadow-none',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-lg px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  ),
)
Button.displayName = 'Button'

export { Button }
