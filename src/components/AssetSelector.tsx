"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSearch } from "@/hooks/useSearch";
import { SUPPORTED_ASSETS } from "@/lib/assets";
import type { AssetRef, AssetType } from "@/lib/types";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<AssetType, string> = {
  stock: "Stocks",
  index: "Indexes",
  crypto: "Crypto",
};

const TYPE_ORDER: AssetType[] = ["stock", "index", "crypto"];

interface AssetSelectorProps {
  value: string | null;
  onSelect: (symbol: string) => void;
}

/** Debounce a value by the given delay (ms). */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Search-as-you-type combobox for picking a stock, index or crypto asset.
 *
 * @param props - The current value and selection callback.
 * @returns The selector element.
 */
export function AssetSelector({ value, onSelect }: AssetSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const debouncedQuery = useDebounced(query, 300);

  const search = useSearch(debouncedQuery);

  const selected = SUPPORTED_ASSETS.find((a) => a.symbol === value);

  const filtered = React.useMemo<readonly AssetRef[]>(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return SUPPORTED_ASSETS;
    // Show curated matches instantly while the live search resolves.
    const local = SUPPORTED_ASSETS.filter(
      (a) =>
        a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    );
    return search.data?.results ?? local;
  }, [debouncedQuery, search.data]);

  const grouped = React.useMemo(() => {
    const groups: Record<AssetType, AssetRef[]> = {
      stock: [],
      index: [],
      crypto: [],
    };
    for (const asset of filtered) groups[asset.type].push(asset);
    return groups;
  }, [filtered]);

  function handleSelect(symbol: string) {
    onSelect(symbol);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Select an asset"
          className="w-full justify-between sm:w-80"
        >
          {value ? (
            <span className="truncate">
              {selected ? `${selected.symbol} · ${selected.name}` : value}
            </span>
          ) : (
            <span className="text-muted-foreground">
              Search stocks, indexes, crypto…
            </span>
          )}
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Type a symbol or name…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {search.isFetching ? "Searching…" : "No assets found."}
            </CommandEmpty>
            {TYPE_ORDER.map((type) =>
              grouped[type].length > 0 ? (
                <CommandGroup key={type} heading={TYPE_LABELS[type]}>
                  {grouped[type].map((asset) => (
                    <CommandItem
                      key={asset.symbol}
                      value={asset.symbol}
                      onSelect={() => handleSelect(asset.symbol)}
                    >
                      <Check
                        className={cn(
                          "size-4",
                          value === asset.symbol ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden
                      />
                      <span className="font-medium">{asset.symbol}</span>
                      <span className="truncate text-muted-foreground">
                        {asset.name}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null,
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
