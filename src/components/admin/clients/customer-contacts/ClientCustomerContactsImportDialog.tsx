import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/use-toast";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  onCompleted: () => void;
};

type ImportReport = {
  importId: string;
  created: number;
  skippedDuplicate: number;
  invalid: number;
  totalRows: number;
};

export function ClientCustomerContactsImportDialog({
  open,
  onOpenChange,
  clientId,
  onCompleted,
}: Props) {
  const [label, setLabel] = useState("");
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setLabel("");
    setSource("");
    setNotes("");
    setFile(null);
    setReport(null);
  };

  const onSubmit = async () => {
    if (!file || !label.trim() || !source.trim()) {
      toast({
        title: "Missing fields",
        description: "Label, source, and a CSV/XLSX file are required.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      let csvText = "";
      if (file.name.toLowerCase().endsWith(".csv")) {
        csvText = await file.text();
      } else {
        toast({
          title: "Convert spreadsheet first",
          description: "Save the sheet as CSV before importing.",
          variant: "destructive",
        });
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        throw new Error("Not signed in");
      }

      const { data, error } = await supabase.functions.invoke(
        "client-customer-contacts-import",
        {
          body: {
            clientId,
            label: label.trim(),
            source: source.trim(),
            fileName: file.name,
            csvText,
            notes: notes.trim() || undefined,
          },
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (error) throw error;
      if (!data?.ok) {
        throw new Error(data?.error ?? "Import failed");
      }

      setReport({
        importId: data.importId,
        created: data.created,
        skippedDuplicate: data.skippedDuplicate,
        invalid: data.invalid,
        totalRows: data.totalRows,
      });
      onCompleted();
      toast({ title: "Import complete" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Import failed", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import customer contacts</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="import-label">Import label</Label>
            <Input
              id="import-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="HARC handover Oct 2026"
            />
          </div>
          <div>
            <Label htmlFor="import-source">Source key (required)</Label>
            <Input
              id="import-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="harc_handover_2026-10-29"
            />
          </div>
          <div>
            <Label htmlFor="import-file">CSV file</Label>
            <Input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Columns: Name, Company, Email, Phone, Address, Postcode, Customer type
              (semicolon-separated), Source, Date added. All imports set do-not-contact.
            </p>
          </div>
          <div>
            <Label htmlFor="import-notes">Notes</Label>
            <Textarea
              id="import-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>

          {report ? (
            <div className="rounded-md border p-3 text-sm space-y-1">
              <div>Created: {report.created}</div>
              <div>Skipped duplicates: {report.skippedDuplicate}</div>
              <div>Invalid rows: {report.invalid}</div>
              <div>Total rows read: {report.totalRows}</div>
              <div className="text-muted-foreground">Import id: {report.importId}</div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={onSubmit} disabled={loading}>
            {loading ? "Importing…" : "Run import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
