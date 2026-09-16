import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
}

export const Button = ({ variant = "primary", className = "", ...rest }: ButtonProps) => (
  <button
    className={
      `rounded-md px-4 py-2 text-sm font-medium transition-colors ` +
      (variant === "primary"
        ? "bg-blue-600 text-white hover:bg-blue-700 "
        : variant === "secondary"
          ? "bg-gray-200 text-gray-900 hover:bg-gray-300 "
          : "bg-transparent text-gray-700 hover:bg-gray-100 ") +
      className
    }
    {...rest}
  />
);
