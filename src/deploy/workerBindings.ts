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
      type: "durable_object_namespace";
      name: string;
      class_name: string;
      script_name?: string;
      environment?: string;
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
