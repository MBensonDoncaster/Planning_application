-- All module rows share the existing migration history and ownership tree.
ALTER TABLE api_keys ADD CONSTRAINT api_keys_id_integration_key UNIQUE (id, integration_id);
CREATE TABLE cfs_submissions (
 id UUID PRIMARY KEY CHECK (substring(id::TEXT,15,1)='4' AND substring(id::TEXT,20,1) IN ('8','9','a','b')),
 reference_number TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 submitted_at TIMESTAMPTZ(3), organisation TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
 raw_json JSONB NOT NULL CHECK (jsonb_typeof(raw_json)='object'),
 received_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 actor_type "IdempotencyActorType" NOT NULL,
 submitted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 integration_id UUID REFERENCES integrations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 api_key_id UUID,
 ingestion_channel "IngestionChannel" NOT NULL,
 input_format_version TEXT NOT NULL CHECK (length(btrim(input_format_version))>0),
 mapping_version TEXT NOT NULL CHECK (length(btrim(mapping_version))>0),
 warnings JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings)='array'),
 CONSTRAINT cfs_submissions_key_owner_fkey FOREIGN KEY(api_key_id,integration_id) REFERENCES api_keys(id,integration_id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT cfs_submissions_actor_check CHECK (
  (actor_type='USER' AND submitted_by_user_id IS NOT NULL AND integration_id IS NULL AND api_key_id IS NULL AND ingestion_channel IN ('FILE_JSON','FILE_ZIP'))
  OR (actor_type='INTEGRATION' AND submitted_by_user_id IS NULL AND integration_id IS NOT NULL AND api_key_id IS NOT NULL AND ingestion_channel='INTEGRATION_API')
 )
);
CREATE INDEX cfs_submissions_received_idx ON cfs_submissions(received_at DESC,id DESC);
CREATE INDEX cfs_submissions_submitted_idx ON cfs_submissions(submitted_at);
CREATE INDEX cfs_submissions_reference_idx ON cfs_submissions(reference_number);
CREATE INDEX cfs_submissions_user_idx ON cfs_submissions(submitted_by_user_id);
CREATE INDEX cfs_submissions_integration_idx ON cfs_submissions(integration_id);
CREATE INDEX cfs_submissions_key_idx ON cfs_submissions(api_key_id,integration_id);
CREATE TABLE cfs_properties (
 id UUID PRIMARY KEY, submission_id UUID NOT NULL REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 property_index INTEGER NOT NULL CHECK (property_index>=0), address TEXT NOT NULL DEFAULT '', postcode TEXT,
 postcode_area TEXT, uprn TEXT, usrn TEXT, ward TEXT, region TEXT, local_authority_district TEXT,
 property_type TEXT, property_type_description TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
 x DOUBLE PRECISION, y DOUBLE PRECISION, town TEXT, street TEXT,
 CONSTRAINT cfs_properties_order_key UNIQUE(submission_id,property_index),
 CONSTRAINT cfs_properties_owner_key UNIQUE(id,submission_id)
);
CREATE INDEX cfs_properties_postcode_area_idx ON cfs_properties(postcode_area);
CREATE TABLE cfs_proposals (
 id UUID PRIMARY KEY, submission_id UUID NOT NULL REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 proposal_index INTEGER NOT NULL CHECK (proposal_index>=0), description TEXT NOT NULL DEFAULT '',
 project_types JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(project_types)='array'),
 CONSTRAINT cfs_proposals_order_key UNIQUE(submission_id,proposal_index),
 CONSTRAINT cfs_proposals_owner_key UNIQUE(id,submission_id)
);
CREATE TABLE cfs_responses (
 id UUID PRIMARY KEY, submission_id UUID NOT NULL REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 question TEXT NOT NULL, answer TEXT NOT NULL, metadata_id TEXT,
 question_index INTEGER NOT NULL CHECK(question_index>=0), response_index INTEGER NOT NULL CHECK(response_index>=0),
 CONSTRAINT cfs_responses_order_key UNIQUE(submission_id,question_index,response_index)
);
CREATE TABLE cfs_designations (
 id UUID PRIMARY KEY, submission_id UUID NOT NULL REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 property_id UUID, designation_index INTEGER NOT NULL CHECK(designation_index>=0),
 value TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', intersects BOOLEAN NOT NULL DEFAULT false,
 entities JSONB CHECK(entities IS NULL OR jsonb_typeof(entities)='array'),
 CONSTRAINT cfs_designations_property_fkey FOREIGN KEY(property_id,submission_id) REFERENCES cfs_properties(id,submission_id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT cfs_designations_property_order_key UNIQUE(property_id,designation_index)
);
CREATE UNIQUE INDEX cfs_designations_submission_order_key ON cfs_designations(submission_id,designation_index) WHERE property_id IS NULL;
CREATE INDEX cfs_designations_submission_idx ON cfs_designations(submission_id);
CREATE INDEX cfs_designations_property_idx ON cfs_designations(property_id,submission_id);
CREATE TABLE cfs_boundaries (
 id UUID PRIMARY KEY, submission_id UUID NOT NULL REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 property_id UUID, proposal_id UUID, boundary_index INTEGER NOT NULL CHECK(boundary_index>=0),
 boundary_type TEXT NOT NULL, raw_geo_json JSONB NOT NULL,
 square_metres DOUBLE PRECISION, hectares DOUBLE PRECISION, exportable BOOLEAN NOT NULL DEFAULT false,
 validation_warnings JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(validation_warnings)='array'),
 CONSTRAINT cfs_boundaries_property_fkey FOREIGN KEY(property_id,submission_id) REFERENCES cfs_properties(id,submission_id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT cfs_boundaries_proposal_fkey FOREIGN KEY(proposal_id,submission_id) REFERENCES cfs_proposals(id,submission_id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT cfs_boundaries_owner_check CHECK (
  (boundary_type='property_title_boundary' AND property_id IS NOT NULL AND proposal_id IS NULL)
  OR (boundary_type='proposal_site_boundary' AND proposal_id IS NOT NULL AND property_id IS NULL)
 ),
 CONSTRAINT cfs_boundaries_property_order_key UNIQUE(property_id,boundary_index),
 CONSTRAINT cfs_boundaries_proposal_order_key UNIQUE(proposal_id,boundary_index)
);
CREATE INDEX cfs_boundaries_submission_idx ON cfs_boundaries(submission_id);
CREATE INDEX cfs_boundaries_property_idx ON cfs_boundaries(property_id,submission_id);
CREATE INDEX cfs_boundaries_proposal_idx ON cfs_boundaries(proposal_id,submission_id);
CREATE TABLE cfs_pre_assessments (
 id UUID PRIMARY KEY, submission_id UUID NOT NULL REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 assessment_index INTEGER NOT NULL CHECK(assessment_index>=0), value TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 CONSTRAINT cfs_pre_assessments_order_key UNIQUE(submission_id,assessment_index)
);
CREATE TABLE cfs_reporting_fields (
 submission_id UUID PRIMARY KEY REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 site_name TEXT, current_use TEXT, applicant_role TEXT, owner_count INTEGER CHECK(owner_count>=0),
 previously_developed BOOLEAN, previously_promoted BOOLEAN, previous_planning_history BOOLEAN,
 proposed_uses JSONB CHECK(proposed_uses IS NULL OR jsonb_typeof(proposed_uses)='array'),
 mixed_use BOOLEAN, public_highway_access BOOLEAN, access_details TEXT, development_start TEXT, developer_interest TEXT,
 viability_issues BOOLEAN, abnormal_costs BOOLEAN, constraints_investigation TEXT, other_information TEXT,
 contact_details TEXT, declaration_confirmed BOOLEAN, anticipated_scale TEXT
);
-- Chunks, not one unbounded vector, let Task 18 index the full accepted payload.
CREATE TABLE cfs_search_documents (
 submission_id UUID NOT NULL REFERENCES cfs_submissions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 chunk_index INTEGER NOT NULL CHECK(chunk_index>=0), search_text TEXT NOT NULL,
 english_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english'::regconfig,search_text)) STORED,
 simple_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,search_text)) STORED,
 PRIMARY KEY(submission_id,chunk_index)
);
CREATE INDEX cfs_search_documents_english_idx ON cfs_search_documents USING GIN(english_vector);
CREATE INDEX cfs_search_documents_simple_idx ON cfs_search_documents USING GIN(simple_vector);
