from neo4j import GraphDatabase
from backend.core.config import NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD

class GraphClient:
    def __init__(self):
        self.driver = GraphDatabase.driver(
            NEO4J_URI,
            auth=(NEO4J_USERNAME, NEO4J_PASSWORD)
        )

    def verify_connection(self):
        self.driver.verify_connectivity()
        print("✅ Neo4j connected successfully")

    def close(self):
        self.driver.close()

    def run(self, query, parameters=None):
        with self.driver.session() as session:
            result = session.run(query, parameters or {})
            return [record.data() for record in result]
    
    def apply_schema(self):
        from backend.graph.schema import SCHEMA_QUERIES
        for query in SCHEMA_QUERIES:
            self.run(query)
        print("✅ Schema applied successfully")

graph_client = GraphClient()