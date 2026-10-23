import { RoutePending } from "@/components/RoutePending";

export default function Loading() {
  return <RoutePending title="The Clock" what="reading the contract's own constants from the chain" />;
}
