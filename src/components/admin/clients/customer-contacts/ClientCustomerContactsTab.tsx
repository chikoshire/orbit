import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClientCustomerContactsBanner } from "./ClientCustomerContactsBanner";
import { ClientCustomerContactsImportDialog } from "./ClientCustomerContactsImportDialog";
import { toast } from "@/components/ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PAGE_SIZE = 25;

export type ClientCustomerContact = {
  id: string;
  client_id: string;
  import_id: string | null;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  contact_types: string[];
  tags: string[];
  source: string;
  source_detail: string | null;
  date_added: string | null;
  do_not_contact: boolean;
  contact_permission: string;
};

type Props = {
  clientId: string;
  isAdmin: boolean;
};

export function ClientCustomerContactsTab({ clientId, isAdmin }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [hasEmail, setHasEmail] = useState<"any" | "yes" | "no">("any");
  const [hasPhone, setHasPhone] = useState<"any" | "yes" | "no">("any");
  const [page, setPage] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [undoImportId, setUndoImportId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: [
      "client-customer-contacts",
      clientId,
      search,
      typeFilter,
      tagFilter,
      sourceFilter,
      hasEmail,
      hasPhone,
      page,
    ],
    enabled: isAdmin,
    queryFn: async () => {
      let query = supabase
        .from("client_customer_contacts")
        .select("*", { count: "exact" })
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      if (search.trim()) {
        const q = `%${search.trim()}%`;
        query = query.or(
          `name.ilike.${q},company.ilike.${q},email.ilike.${q},phone.ilike.${q}`,
        );
      }

      if (sourceFilter !== "all") {
        query = query.eq("source", sourceFilter);
      }

      if (hasEmail === "yes") {
        query = query.not("email", "is", null);
      } else if (hasEmail === "no") {
        query = query.is("email", null);
      }

      if (hasPhone === "yes") {
        query = query.not("phone", "is", null);
      } else if (hasPhone === "no") {
        query = query.is("phone", null);
      }

      if (typeFilter.length > 0) {
        query = query.overlaps("contact_types", typeFilter);
      }

      if (tagFilter.length > 0) {
        query = query.overlaps("tags", tagFilter);
      }

      const { data, error, count } = await query;
      if (error) throw error;
      return { rows: (data ?? []) as ClientCustomerContact[], count: count ?? 0 };
    },
  });

  const importsQuery = useQuery({
    queryKey: ["client-contact-imports", clientId],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("client_contact_imports")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const facetValues = useMemo(() => {
    const types = new Set<string>();
    const tags = new Set<string>();
    for (const row of listQuery.data?.rows ?? []) {
      row.contact_types?.forEach((t) => types.add(t));
      row.tags?.forEach((t) => tags.add(t));
    }
    return {
      types: [...types].sort(),
      tags: [...tags].sort(),
      sources: [...new Set((importsQuery.data ?? []).map((i) => i.source))].sort(),
    };
  }, [importsQuery.data, listQuery.data?.rows]);

  const undoMutation = useMutation({
    mutationFn: async (importId: string) => {
      const { data, error } = await supabase.rpc("undo_client_contact_import", {
        p_import_id: importId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Import undone" });
      queryClient.invalidateQueries({ queryKey: ["client-customer-contacts", clientId] });
      queryClient.invalidateQueries({ queryKey: ["client-contact-imports", clientId] });
      setUndoImportId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Undo failed", description: err.message, variant: "destructive" });
    },
  });

  const exportCsv = () => {
    const rows = listQuery.data?.rows ?? [];
    const header = [
      "name",
      "company",
      "email",
      "phone",
      "contact_types",
      "tags",
      "source",
      "date_added",
      "do_not_contact",
      "contact_permission",
    ];
    const lines = [
      header.join(","),
      ...rows.map((row) =>
        [
          row.name,
          row.company,
          row.email,
          row.phone,
          (row.contact_types ?? []).join(";"),
          (row.tags ?? []).join(";"),
          row.source,
          row.date_added,
          row.do_not_contact,
          row.contact_permission,
        ]
          .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `client-customer-contacts-${clientId}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!isAdmin) {
    return null;
  }

  const total = listQuery.data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4" data-orbit-id="src/components/admin/clients/customer-contacts/ClientCustomerContactsTab.tsx:196:5">
      <ClientCustomerContactsBanner />

      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Search name, company, email, phone"
            value={search}
            onChange={(e) => {
              setPage(0);
              setSearch(e.target.value);
            }}
            className="w-72"
          />
          <Select
            value={sourceFilter}
            onValueChange={(value) => {
              setPage(0);
              setSourceFilter(value);
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Source / import" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {facetValues.sources.map((source) => (
                <SelectItem key={source} value={source}>
                  {source}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={hasEmail}
            onValueChange={(v: "any" | "yes" | "no") => setHasEmail(v)}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Has email" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any email</SelectItem>
              <SelectItem value="yes">Has email</SelectItem>
              <SelectItem value="no">No email</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={hasPhone}
            onValueChange={(v: "any" | "yes" | "no") => setHasPhone(v)}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Has phone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any phone</SelectItem>
              <SelectItem value="yes">Has phone</SelectItem>
              <SelectItem value="no">No phone</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportCsv}>
            Export CSV
          </Button>
          <Button onClick={() => setImportOpen(true)}>Import contacts</Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Types</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Date added</TableHead>
            <TableHead>DNC</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(listQuery.data?.rows ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.name ?? "—"}</TableCell>
              <TableCell>{row.company ?? "—"}</TableCell>
              <TableCell>{row.email ?? "—"}</TableCell>
              <TableCell>{row.phone ?? "—"}</TableCell>
              <TableCell className="max-w-[180px] truncate">
                {(row.contact_types ?? []).join(", ") || "—"}
              </TableCell>
              <TableCell className="max-w-[140px] truncate">
                {(row.tags ?? []).join(", ") || "—"}
              </TableCell>
              <TableCell>{row.source}</TableCell>
              <TableCell>{row.date_added ?? "—"}</TableCell>
              <TableCell>
                {row.do_not_contact ? (
                  <Badge variant="destructive">Do not contact</Badge>
                ) : (
                  <Badge variant="secondary">—</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Page {page + 1} of {pageCount} · {total} contacts
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Imports</h3>
        {(importsQuery.data ?? []).map((imp) => (
          <div
            key={imp.id}
            className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
          >
            <div>
              <div className="font-medium">{imp.label}</div>
              <div className="text-muted-foreground">
                {imp.source} · {imp.row_count} rows · {imp.file_name ?? "upload"}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setUndoImportId(imp.id)}>
              Undo import
            </Button>
          </div>
        ))}
      </div>

      <ClientCustomerContactsImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        clientId={clientId}
        onCompleted={() => {
          queryClient.invalidateQueries({ queryKey: ["client-customer-contacts", clientId] });
          queryClient.invalidateQueries({ queryKey: ["client-contact-imports", clientId] });
        }}
      />

      <AlertDialog open={Boolean(undoImportId)} onOpenChange={() => setUndoImportId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this import?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all customer contacts tied to the import batch,
              then removes the import record. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => undoImportId && undoMutation.mutate(undoImportId)}
            >
              Delete imported contacts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
