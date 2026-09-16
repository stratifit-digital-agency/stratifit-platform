import type { HTMLAttributes } from "react";

export const Card = ({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={"rounded-lg border border-gray-200 bg-white p-6 shadow-sm " + className} {...rest} />
);

export const CardTitle = ({ className = "", ...rest }: HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={"text-lg font-semibold text-gray-900 " + className} {...rest} />
);
