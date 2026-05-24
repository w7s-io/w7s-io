export type WorkerUploadBinding =
  | {
      type: "kv_namespace";
      name: string;
      namespace_id: string;
    }
  | {
      type: "r2_bucket";
      name: string;
      bucket_name: string;
    }
  | {
      type: "d1";
      name: string;
      id: string;
    }
  | {
      type: "plain_text";
      name: string;
      text: string;
    }
  | {
      type: "secret_text";
      name: string;
      text: string;
    }
  | {
      type: "service";
      name: string;
      service: string;
      environment?: string;
    };
